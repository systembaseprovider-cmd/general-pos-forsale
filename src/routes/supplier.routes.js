const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const db = require('../database');
const AuditLog = require('../models/AuditLog');
const InventoryMovement = require('../models/InventoryMovement');
const { verifyToken, requireModule } = require('../middleware/auth');

const router = express.Router();
const clean = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const run = (connection, sql, values = []) => new Promise((resolve, reject) => connection.run(sql, values, function(error) {
    if (error) reject(error); else resolve({ id: this.lastID, changes: this.changes });
}));
const get = (connection, sql, values = []) => new Promise((resolve, reject) => connection.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));

router.get('/', verifyToken, requireModule('inventory'), (req, res) => {
    db.all('SELECT id, name, contactName, phone, email, address FROM suppliers WHERE isActive = 1 ORDER BY name', (error, rows) => {
        if (error) return res.status(500).json({ success: false, message: 'Unable to load suppliers' });
        res.json({ success: true, data: rows || [] });
    });
});

router.post('/', verifyToken, requireModule('inventory'), (req, res) => {
    const name = clean(req.body?.name, 160);
    if (name.length < 2) return res.status(400).json({ success: false, message: 'Supplier name must be at least 2 characters' });
    const values = [name, clean(req.body?.contactName, 120), clean(req.body?.phone, 50), clean(req.body?.email, 120), clean(req.body?.address, 300)];
    db.run('INSERT INTO suppliers (name, contactName, phone, email, address) VALUES (?, ?, ?, ?, ?)', values, function(error) {
        if (error) return res.status(error.code === 'SQLITE_CONSTRAINT' ? 409 : 500).json({ success: false, message: error.code === 'SQLITE_CONSTRAINT' ? 'Supplier already exists' : 'Unable to save supplier' });
        res.status(201).json({ success: true, data: { id: this.lastID, name, contactName: values[1], phone: values[2], email: values[3], address: values[4] } });
    });
});

router.post('/receipts', verifyToken, requireModule('inventory'), async (req, res) => {
    const supplierId = Number(req.body?.supplierId);
    const supplierInvoiceNo = clean(req.body?.supplierInvoiceNo, 120);
    const notes = clean(req.body?.notes, 500);
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const quantities = new Map();
    for (const item of rawItems) {
        const productId = Number(item?.productId), quantity = Number(item?.quantity), unitCost = Number(item?.unitCost || 0);
        if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0) {
            return res.status(400).json({ success: false, message: 'Each received item needs a product, whole quantity, and valid unit cost' });
        }
        if (quantities.has(productId)) return res.status(400).json({ success: false, message: 'A product can appear only once per receiving record' });
        quantities.set(productId, { productId, quantity, unitCost: Math.round(unitCost * 100) / 100 });
    }
    if (!Number.isSafeInteger(supplierId) || supplierId <= 0 || quantities.size === 0) return res.status(400).json({ success: false, message: 'Supplier and at least one received item are required' });
    const connection = new sqlite3.Database(db.databasePath);
    connection.configure('busyTimeout', 5000);
    try {
        await run(connection, 'PRAGMA foreign_keys = ON'); await run(connection, 'BEGIN IMMEDIATE');
        const supplier = await get(connection, 'SELECT id, name FROM suppliers WHERE id = ? AND isActive = 1', [supplierId]);
        if (!supplier) throw new Error('Supplier is unavailable');
        const items = [];
        for (const item of quantities.values()) {
            const product = await get(connection, 'SELECT id, name, stock FROM products WHERE id = ? AND isActive = 1', [item.productId]);
            if (!product) throw new Error(`Product ID ${item.productId} is unavailable`);
            items.push({ ...item, product });
        }
        const receiptNo = `GR-${req.user.branch}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const totalCost = items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
        const receipt = await run(connection, `INSERT INTO purchaseReceipts (receiptNo, supplierId, userId, branch, supplierInvoiceNo, notes, totalCost) VALUES (?, ?, ?, ?, ?, ?, ?)`, [receiptNo, supplierId, req.user.id, req.user.branch, supplierInvoiceNo, notes, totalCost]);
        for (const item of items) {
            await run(connection, 'INSERT INTO purchaseReceiptItems (purchaseReceiptId, productId, quantity, unitCost) VALUES (?, ?, ?, ?)', [receipt.id, item.productId, item.quantity, item.unitCost]);
            await run(connection, 'UPDATE products SET stock = stock + ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [item.quantity, item.productId]);
            await InventoryMovement.createOnConnection(connection, { productId: item.productId, userId: req.user.id, branch: req.user.branch, movementType: 'MANUAL_ADD', quantityDelta: item.quantity, previousStock: item.product.stock, newStock: item.product.stock + item.quantity, reason: `Purchase received from ${supplier.name}`, reference: receiptNo });
        }
        await AuditLog.createOnConnection(connection, { eventType: 'PURCHASE_RECEIVED', userId: req.user.id, branch: req.user.branch, reason: `Received ${items.length} item type(s) from ${supplier.name}`, details: { receiptNo, supplierId, supplierInvoiceNo, totalCost } });
        await run(connection, 'COMMIT');
        res.status(201).json({ success: true, data: { id: receipt.id, receiptNo, totalCost, itemCount: items.length } });
    } catch (error) {
        await run(connection, 'ROLLBACK').catch(() => {});
        res.status(error.message.includes('unavailable') ? 400 : 500).json({ success: false, message: error.message || 'Unable to record receiving' });
    } finally { connection.close(); }
});

module.exports = router;
