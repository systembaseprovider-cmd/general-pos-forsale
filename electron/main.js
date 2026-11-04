const { app, BrowserWindow, dialog, screen, ipcMain } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { autoUpdater } = require('electron-updater');

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const [window] = BrowserWindow.getAllWindows();
        if (window) {
            if (window.isMinimized()) window.restore();
            window.focus();
        }
    });
}

function loadOrCreateSecret(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(filePath, secret, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return secret;
}

function loadOrCreateFirstRunCredentials(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const credentials = {
        username: 'admin',
        password: 'admin123'
    };
    fs.writeFileSync(filePath, JSON.stringify(credentials), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
    });
    return credentials;
}

function applyRequestedRestore(databasePath) {
    const requestPath = `${databasePath}.restore-request.json`;
    if (!fs.existsSync(requestPath)) return;
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    if (!request.source || !fs.existsSync(request.source)) throw new Error('Requested backup file is unavailable.');
    const staged = `${databasePath}.restore-staged`;
    fs.copyFileSync(request.source, staged);
    if (fs.existsSync(databasePath)) fs.renameSync(databasePath, `${databasePath}.before-restore-${Date.now()}`);
    fs.renameSync(staged, databasePath);
    fs.unlinkSync(requestPath);
}

async function startDesktopApp() {
    await app.whenReady();

    const dataDirectory = app.getPath('userData');
    fs.mkdirSync(dataDirectory, { recursive: true });

    process.env.POS_APP_DATA_DIR = dataDirectory;
    process.env.POS_DB_PATH = path.join(dataDirectory, 'pos.db');
    process.env.POS_BACKUP_DIR = path.join(dataDirectory, 'backups');
    process.env.POS_PORT = '0';
    // A store router can reach this local server; internet is never required for sales.
    process.env.POS_BIND_HOST = '0.0.0.0';
    process.env.POS_DISABLE_SAMPLE_DATA = 'true';
    process.env.JWT_SECRET = loadOrCreateSecret(path.join(dataDirectory, 'jwt-secret'));
    applyRequestedRestore(process.env.POS_DB_PATH);

    const credentialsPath = path.join(dataDirectory, 'first-run-credentials.json');
    const firstRunCredentials = loadOrCreateFirstRunCredentials(credentialsPath);
    process.env.POS_ADMIN_USERNAME = firstRunCredentials.username;
    process.env.POS_ADMIN_PASSWORD = firstRunCredentials.password;

    const { server, db, shutdown } = require('../server');
    let mainWindow;
    let credentialsShown = false;
    const updateUrl = String(process.env.POS_UPDATE_URL || '').trim().replace(/\/$/, '');
    const updatesEnabled = /^https:\/\//.test(updateUrl);
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    if (updatesEnabled) autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });
    autoUpdater.on('error', error => console.warn('Automatic update check failed:', error.message));
    autoUpdater.on('update-downloaded', info => {
        dialog.showMessageBox({ type: 'info', title: 'Update ready', message: `Version ${info.version} is ready.`, detail: 'It will install automatically when General POS is closed.' });
    });

    const showFirstRunCredentials = async () => {
        if (credentialsShown) return;

        const User = require('../src/models/User');
        const user = await User.findByUsername(firstRunCredentials.username);
        if (!user || !User.verifyPassword(firstRunCredentials.password, user.password)) {
            fs.rmSync(credentialsPath, { force: true });
            return;
        }

        credentialsShown = true;
        await dialog.showMessageBox({
            type: 'info',
            title: 'pos-catalog.com first-time setup',
            message: 'Your administrator account is ready.',
            detail: `Username: ${firstRunCredentials.username}\nTemporary password: ${firstRunCredentials.password}\n\nSign in, then change this password. This message will appear again until you change it.`,
            buttons: ['OK']
        });
    };

    const openWindow = () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
            dialog.showErrorBox('pos-catalog.com could not start', 'The local POS server did not provide a valid address.');
            app.quit();
            return;
        }

        const { width: workAreaWidth, height: workAreaHeight } = screen.getPrimaryDisplay().workAreaSize;
        mainWindow = new BrowserWindow({
            width: Math.min(1440, workAreaWidth),
            height: Math.min(900, workAreaHeight),
            minWidth: Math.min(1024, workAreaWidth),
            minHeight: Math.min(700, workAreaHeight),
            show: false,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true
            }
        });

        mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        mainWindow.webContents.on('will-navigate', (event, url) => {
            if (url !== `http://127.0.0.1:${address.port}/` &&
                !url.startsWith(`http://127.0.0.1:${address.port}/`)) {
                event.preventDefault();
            }
        });
        mainWindow.once('ready-to-show', () => {
            mainWindow.maximize();
            mainWindow.show();
        });
        mainWindow.loadURL(`http://127.0.0.1:${address.port}/`);
        db.ready.then(showFirstRunCredentials).catch(error => {
            console.error('Unable to verify first-run administrator setup:', error);
        });
        // Offline sales are never blocked: failed internet checks are intentionally non-fatal.
        if (updatesEnabled) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10000);
    };

    ipcMain.handle('pos:get-printers', async event => {
        const printers = await event.sender.getPrintersAsync();
        return printers.map(printer => ({ name: printer.name, displayName: printer.displayName, isDefault: printer.isDefault, status: printer.status }));
    });
    ipcMain.handle('pos:print-receipt', async (_event, payload) => {
        const html = typeof payload?.html === 'string' ? payload.html : '';
        const deviceName = typeof payload?.deviceName === 'string' ? payload.deviceName : '';
        if (!html || html.length > 250000) throw new Error('Receipt content is invalid.');
        const printWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
        try {
            await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><style>@page{size:80mm auto;margin:0}body{width:72mm;margin:0;font-family:Arial,sans-serif;font-size:12px}</style></head><body>${html}</body></html>`)}`);
            await new Promise((resolve, reject) => printWindow.webContents.print({ silent: true, printBackground: true, deviceName }, (success, reason) => success ? resolve() : reject(new Error(reason || 'Printer rejected the receipt'))));
            return { success: true };
        } finally { if (!printWindow.isDestroyed()) printWindow.destroy(); }
    });

    server.once('listening', openWindow);
    server.once('error', error => {
        dialog.showErrorBox('pos-catalog.com could not start', error.message);
        app.quit();
    });

    app.on('before-quit', event => {
        if (server.listening) {
            event.preventDefault();
            shutdown(() => app.exit(0));
        }
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0 && server.listening) openWindow();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}

if (hasInstanceLock) {
    startDesktopApp().catch(error => {
        console.error('Unable to initialize General POS desktop app:', error);
        dialog.showErrorBox('General POS could not start', error.message);
        app.quit();
    });
}
