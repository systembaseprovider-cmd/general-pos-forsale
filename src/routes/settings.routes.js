const express = require('express');
const AppSettings = require('../models/AppSettings');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/public-branding', async (req, res) => {
    try {
        const settings = await AppSettings.getPublic();
        return res.status(200).json({ success: true, data: settings });
    } catch (error) {
        console.error('Get public branding error:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to load app branding'
        });
    }
});

router.get('/branding', verifyToken, async (req, res) => {
    try {
        const settings = await AppSettings.get();
        return res.status(200).json({ success: true, data: settings });
    } catch (error) {
        console.error('Get receipt branding settings error:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to load receipt details'
        });
    }
});

router.put('/branding', verifyToken, requireRole('admin'), async (req, res) => {
    try {
        const settings = await AppSettings.update(req.body || {});
        return res.status(200).json({
            success: true,
            message: 'App branding and receipt details saved',
            data: settings
        });
    } catch (error) {
        console.error('Update branding settings error:', error);
        return res.status(400).json({
            success: false,
            message: error.message || 'Unable to save app branding'
        });
    }
});

module.exports = router;
