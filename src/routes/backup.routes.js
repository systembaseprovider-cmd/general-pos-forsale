const express = require('express');
const fs = require('fs');
const path = require('path');
const { verifyToken, requireRole } = require('../middleware/auth');
const db = require('../database');
const { createBackup } = require('../services/backup');

const router = express.Router();
const backupDirectory = () => path.resolve(process.env.POS_BACKUP_DIR || path.join(__dirname, '..', '..', 'backups'));

router.get('/', verifyToken, requireRole('admin'), (req, res) => {
    const directory = backupDirectory();
    const backups = fs.existsSync(directory)
        ? fs.readdirSync(directory, { withFileTypes: true })
            .filter(entry => entry.isFile() && /^pos-backup-.*\.db$/.test(entry.name))
            .map(entry => {
                const filePath = path.join(directory, entry.name);
                const stat = fs.statSync(filePath);
                return { name: entry.name, createdAt: stat.mtime.toISOString(), size: stat.size };
            })
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : [];
    res.json({ success: true, data: backups });
});

router.post('/', verifyToken, requireRole('admin'), async (req, res) => {
    try {
        const filePath = await createBackup(db);
        res.status(201).json({ success: true, data: { name: path.basename(filePath) } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/restore-request', verifyToken, requireRole('admin'), (req, res) => {
    const name = String(req.body?.name || '');
    if (!/^pos-backup-[A-Za-z0-9.-]+\.db$/.test(name)) {
        return res.status(400).json({ success: false, message: 'Invalid backup file.' });
    }
    const source = path.join(backupDirectory(), name);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        return res.status(404).json({ success: false, message: 'Backup file was not found.' });
    }
    const requestPath = `${path.resolve(db.databasePath)}.restore-request.json`;
    fs.writeFileSync(requestPath, JSON.stringify({ source, requestedAt: new Date().toISOString() }), { mode: 0o600 });
    return res.json({ success: true, message: 'Restore is ready. Close and reopen General POS to apply it.' });
});

module.exports = router;
