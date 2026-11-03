const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function getBackupDirectory() {
    return path.resolve(process.env.POS_BACKUP_DIR || path.join(__dirname, '..', '..', 'backups'));
}

function createBackup(db) {
    const backupDirectory = getBackupDirectory();
    const databasePath = path.resolve(db.databasePath);
    if (backupDirectory === path.dirname(databasePath)) {
        throw new Error('Backup directory must be separate from the live database directory');
    }

    fs.mkdirSync(backupDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDirectory, `pos-backup-${timestamp}.db`);

    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error) => {
            if (settled) return;
            settled = true;
            try {
                if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
            } catch (cleanupError) {
                console.error('Unable to remove incomplete database backup:', cleanupError);
            }
            reject(error);
        };
        const complete = () => {
            if (settled) return;
            settled = true;
            try {
                const stats = fs.statSync(backupPath);
                if (!stats.isFile() || stats.size === 0) {
                    throw new Error('Database backup completed but the backup file is empty');
                }
                resolve(backupPath);
            } catch (validationError) {
                reject(validationError);
            }
        };
        const backup = db.backup(backupPath, (error) => {
            if (error) {
                fail(error);
            }
        });
        backup.once('error', fail);
        backup.step(-1, (error) => error ? fail(error) : complete());
    });
}

function pruneBackups() {
    const backupDirectory = getBackupDirectory();
    if (!fs.existsSync(backupDirectory)) return;

    const cutoff = Date.now() - RETENTION_DAYS * DAY_MS;
    for (const entry of fs.readdirSync(backupDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^pos-backup-.*\.db$/.test(entry.name)) continue;
        const backupPath = path.join(backupDirectory, entry.name);
        if (fs.statSync(backupPath).mtimeMs < cutoff) fs.unlinkSync(backupPath);
    }
}

function startBackupScheduler(db) {
    let timer;

    const run = async () => {
        try {
            const backupPath = await createBackup(db);
            pruneBackups();
            console.log('Database backup created:', backupPath);
            timer = setTimeout(run, DAY_MS);
        } catch (error) {
            console.error('Database backup failed; retrying in one hour:', error);
            timer = setTimeout(run, 60 * 60 * 1000);
        }
        timer.unref();
    };

    run();
    return () => clearTimeout(timer);
}

module.exports = {
    createBackup,
    pruneBackups,
    startBackupScheduler
};
