const express = require('express');
const path = require('path');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
const packageInfo = require(path.join(__dirname, '..', '..', 'package.json'));

router.get('/status', verifyToken, requireRole('admin'), (req, res) => {
    const configuredUrl = String(process.env.POS_UPDATE_URL || '').trim();
    let updatesConfigured = false;
    try {
        const parsed = new URL(configuredUrl);
        updatesConfigured = parsed.protocol === 'https:';
    } catch {
        updatesConfigured = false;
    }

    return res.status(200).json({
        success: true,
        data: {
            currentVersion: packageInfo.version,
            updatesConfigured
        }
    });
});

module.exports = router;
