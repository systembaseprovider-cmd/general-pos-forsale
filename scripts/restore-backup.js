const fs = require('fs');
const net = require('net');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
require('../src/services/loadEnv')();

const projectDirectory = path.join(__dirname, '..');
const databasePath = path.resolve(process.env.POS_DB_PATH || path.join(projectDirectory, 'pos.db'));
const lockPath = path.join(projectDirectory, '.pos-server.lock');
const backupPath = process.argv[2] ? path.resolve(process.argv[2]) : '';

function checkServerStopped() {
    if (fs.existsSync(lockPath)) {
        let processId;
        try {
            processId = Number(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid);
        } catch (error) {
            throw new Error(`Cannot read POS server lock file: ${error.message}`);
        }
        if (Number.isSafeInteger(processId) && processId > 0) {
            try {
                process.kill(processId, 0);
                throw new Error(`POS server process ${processId} is running. Stop it before restoring a backup.`);
            } catch (error) {
                if (error.code !== 'ESRCH') throw error;
            }
        }
        fs.unlinkSync(lockPath);
    }

    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: 3000 });
        socket.setTimeout(1000);
        socket.once('connect', () => {
            socket.destroy();
            reject(new Error('A service is listening on port 3000. Stop the POS server before restoring a backup.'));
        });
        socket.once('error', (error) => {
            if (error.code === 'ECONNREFUSED') resolve();
            else reject(error);
        });
        socket.once('timeout', () => {
            socket.destroy();
            reject(new Error('Could not confirm the POS server is stopped.'));
        });
    });
}

function validateBackup(filePath) {
    return new Promise((resolve, reject) => {
        const backupDb = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (openError) => {
            if (openError) return reject(openError);
            backupDb.get('PRAGMA integrity_check', (integrityError, result) => {
                backupDb.close((closeError) => {
                    if (integrityError) return reject(integrityError);
                    if (closeError) return reject(closeError);
                    if (!result || result.integrity_check !== 'ok') {
                        return reject(new Error('Backup failed SQLite integrity_check'));
                    }
                    resolve();
                });
            });
        });
    });
}

async function restore() {
    if (!backupPath) {
        throw new Error('Usage: node scripts/restore-backup.js <backup-file>');
    }
    if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) {
        throw new Error(`Backup file does not exist: ${backupPath}`);
    }
    if (backupPath === databasePath) {
        throw new Error('The selected backup path is the live database');
    }

    await checkServerStopped();
    await validateBackup(backupPath);

    if (fs.existsSync(databasePath)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safetyCopyPath = `${databasePath}.before-restore-${timestamp}`;
        fs.copyFileSync(databasePath, safetyCopyPath);
        console.log('Current database saved as:', safetyCopyPath);
    }
    fs.copyFileSync(backupPath, databasePath);
    console.log('Database restored from:', backupPath);
}

restore().catch((error) => {
    console.error('Database restore failed:', error.message);
    process.exitCode = 1;
});
