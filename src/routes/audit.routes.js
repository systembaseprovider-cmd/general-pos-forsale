const express = require('express');
const AuditLog = require('../models/AuditLog');
const db = require('../database');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(verifyToken);

router.get('/', requireRole('admin'), async (req, res) => {
    try {
        const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
        const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500 ||
            !Number.isInteger(offset) || offset < 0) {
            return res.status(400).json({
                success: false,
                message: 'Limit must be 1-500 and offset must be a non-negative integer'
            });
        }

        const entries = await AuditLog.getAll({
            branch: req.user.branch,
            limit,
            offset
        });
        return res.status(200).json({
            success: true,
            data: entries,
            count: entries.length
        });
    } catch (error) {
        console.error('Get audit logs error:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to retrieve audit logs'
        });
    }
});

router.post('/cart-voids', async (req, res) => {
    try {
        const { reason, transactionNumber, items } = req.body || {};
        const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
        if (normalizedReason.length < 5 || normalizedReason.length > 200) {
            return res.status(400).json({
                success: false,
                message: 'Void reason must be 5-200 characters'
            });
        }
        if (!Array.isArray(items) || items.length === 0 || items.length > 100 ||
            items.some(item => !item ||
                !Number.isSafeInteger(item.productId) || item.productId <= 0 ||
                !Number.isSafeInteger(item.quantity) || item.quantity <= 0)) {
            return res.status(400).json({
                success: false,
                message: 'Void must include 1-100 valid product and quantity entries'
            });
        }

        await AuditLog.createOnConnection(db, {
            eventType: 'CART_VOIDED',
            userId: req.user.id,
            branch: req.user.branch,
            reason: normalizedReason,
            details: {
                transactionNumber: typeof transactionNumber === 'string'
                    ? transactionNumber.slice(0, 40)
                    : '',
                items: items.map(item => ({
                    productId: item.productId,
                    quantity: item.quantity
                }))
            }
        });
        return res.status(201).json({
            success: true,
            message: 'Cart void recorded'
        });
    } catch (error) {
        console.error('Record cart void error:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to record cart void'
        });
    }
});

module.exports = router;
