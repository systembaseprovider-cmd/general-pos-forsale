const express = require('express');
const db = require('../database');
const { verifyToken, requireModule } = require('../middleware/auth');
const router = express.Router();
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

router.get('/', verifyToken, requireModule('pos'), (req, res) => {
    const term = clean(req.query.q, 120);
    db.all(`SELECT id, name, phone, email, loyaltyPoints FROM customers WHERE isActive = 1 AND (? = '' OR name LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 50`, [term, `%${term}%`, `%${term}%`], (error, rows) => {
        if (error) return res.status(500).json({ success: false, message: 'Unable to load customers' });
        res.json({ success: true, data: rows || [] });
    });
});
router.post('/', verifyToken, requireModule('pos'), (req, res) => {
    const name = clean(req.body?.name, 120), phone = clean(req.body?.phone, 50), email = clean(req.body?.email, 120), notes = clean(req.body?.notes, 500);
    if (name.length < 2) return res.status(400).json({ success: false, message: 'Customer name must be at least 2 characters' });
    db.run('INSERT INTO customers (name, phone, email, notes) VALUES (?, ?, ?, ?)', [name, phone, email, notes], function(error) {
        if (error) return res.status(error.code === 'SQLITE_CONSTRAINT' ? 409 : 500).json({ success: false, message: error.code === 'SQLITE_CONSTRAINT' ? 'Customer already exists' : 'Unable to save customer' });
        res.status(201).json({ success: true, data: { id: this.lastID, name, phone, email, loyaltyPoints: 0 } });
    });
});
router.get('/:id/history', verifyToken, requireModule('pos'), (req, res) => {
    const id = Number(req.params.id);
    db.get('SELECT id, name, phone, email, loyaltyPoints FROM customers WHERE id = ? AND isActive = 1', [id], (customerError, customer) => {
        if (customerError || !customer) return res.status(404).json({ success: false, message: 'Customer not found' });
        db.all(`SELECT txnNo, totalAmount, paymentMethod, createdAt FROM transactions WHERE customerName = ? AND branch = ? ORDER BY createdAt DESC LIMIT 100`, [customer.name, req.user.branch], (historyError, transactions) => {
            if (historyError) return res.status(500).json({ success: false, message: 'Unable to load customer history' });
            res.json({ success: true, data: { ...customer, transactions: transactions || [] } });
        });
    });
});
module.exports = router;
