const { app, BrowserWindow, dialog, screen } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
        password: crypto.randomBytes(18).toString('base64url')
    };
    fs.writeFileSync(filePath, JSON.stringify(credentials), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
    });
    return credentials;
}

async function startDesktopApp() {
    await app.whenReady();

    const dataDirectory = app.getPath('userData');
    fs.mkdirSync(dataDirectory, { recursive: true });

    process.env.POS_APP_DATA_DIR = dataDirectory;
    process.env.POS_DB_PATH = path.join(dataDirectory, 'pos.db');
    process.env.POS_BACKUP_DIR = path.join(dataDirectory, 'backups');
    process.env.POS_PORT = '0';
    process.env.POS_DISABLE_SAMPLE_DATA = 'true';
    process.env.JWT_SECRET = loadOrCreateSecret(path.join(dataDirectory, 'jwt-secret'));

    const credentialsPath = path.join(dataDirectory, 'first-run-credentials.json');
    const firstRunCredentials = loadOrCreateFirstRunCredentials(credentialsPath);
    process.env.POS_ADMIN_USERNAME = firstRunCredentials.username;
    process.env.POS_ADMIN_PASSWORD = firstRunCredentials.password;

    const { server, db, shutdown } = require('../server');
    let mainWindow;
    let credentialsShown = false;

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
            title: 'General POS first-time setup',
            message: 'Your administrator account is ready.',
            detail: `Username: ${firstRunCredentials.username}\nTemporary password: ${firstRunCredentials.password}\n\nSign in, then change this password. This message will appear again until you change it.`,
            buttons: ['OK']
        });
    };

    const openWindow = () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
            dialog.showErrorBox('General POS could not start', 'The local POS server did not provide a valid address.');
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
    };

    server.once('listening', openWindow);
    server.once('error', error => {
        dialog.showErrorBox('General POS could not start', error.message);
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
