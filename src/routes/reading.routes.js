const express = require('express');
const Reading = require('../models/Reading');
const User = require('../models/User');
const { verifyToken, requireRole } = require('../middleware/auth');
const { getBusinessDate, isValidBusinessDate } = require('../services/businessDate');

const router = express.Router();
router.use(verifyToken, requireRole('admin'));

function validateRequestedDate(value, res) {
    if (!isValidBusinessDate(value)) {
        res.status(400).json({
            success: false,
            message: 'A valid business date in YYYY-MM-DD format is required'
        });
        return false;
    }
    if (value > getBusinessDate()) {
        res.status(400).json({
            success: false,
            message: 'Future business dates are not available'
        });
        return false;
    }
    return true;
}

router.get('/x', async (req, res) => {
    try {
        const { date, userId: requestedUserId } = req.query;
        if (!validateRequestedDate(date, res)) return;
        const userId = Number(requestedUserId);
        if (!Number.isSafeInteger(userId) || userId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'A valid cashier is required for X-reading'
            });
        }

        const reading = await Reading.getXReading(req.user.branch, date, userId);
        if (!reading) {
            return res.status(404).json({
                success: false,
                message: 'User not found in this branch'
            });
        }
        return res.status(200).json({ success: true, data: reading });
    } catch (error) {
        console.error('Get X-reading error:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to load X-reading'
        });
    }
});

router.get('/z', async (req, res) => {
    try {
        const { date } = req.query;
        if (!validateRequestedDate(date, res)) return;
        const reading = await Reading.getZReading(req.user.branch, date);
        if (!reading.closed && date !== getBusinessDate()) {
            return res.status(404).json({
                success: false,
                message: 'There is no saved Z-reading for this date'
            });
        }
        return res.status(200).json({ success: true, data: reading });
    } catch (error) {
        console.error('Get Z-reading error:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to load Z-reading'
        });
    }
});

router.post('/z/close', async (req, res) => {
    if (!req.body || req.body.confirmClose !== true) {
        return res.status(400).json({
            success: false,
            message: 'Explicit confirmation is required to close the business day'
        });
    }

    try {
        const businessDate = getBusinessDate();
        const result = await Reading.closeBusinessDay(
            req.user.branch,
            req.user.id,
            req.user.name,
            businessDate
        );
        return res.status(result.alreadyClosed ? 200 : 201).json({
            success: true,
            message: result.alreadyClosed
                ? 'This business day is already closed'
                : 'Z-reading saved; sales, refunds, and voids are locked until tomorrow',
            data: result
        });
    } catch (error) {
        console.error('Close business day error:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to save Z-reading and close the business day'
        });
    }
});

router.get('/users', async (req, res) => {
    try {
        const users = await User.listByBranch(req.user.branch);
        return res.status(200).json({
            success: true,
            data: users.map(user => ({
                id: user.id,
                name: user.name,
                username: user.username,
                role: user.role,
                isActive: Boolean(user.isActive)
            })),
            count: users.length
        });
    } catch (error) {
        console.error('Get reading users error:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to load branch users for X-reading'
        });
    }
});

module.exports = router;
