const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { after, test } = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'general-pos-commerce-'));
process.env.POS_DB_PATH = path.join(directory, 'pos.db');
process.env.POS_DISABLE_SAMPLE_DATA = 'true';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64');
const db = require('../src/database');
const User = require('../src/models/User');
const Product = require('../src/models/Product');
const { generateToken } = require('../src/middleware/auth');
const get = (sql, args = []) => new Promise((resolve, reject) => db.get(sql, args, (error, row) => error ? reject(error) : resolve(row)));

after(async () => { await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); fs.rmSync(directory, { recursive: true, force: true }); });

test('supplier receiving atomically records receipt and increases stock; customers have searchable profiles and history', async () => {
  await db.ready;
  const createdAdmin = await User.create('commerce-admin', 'password-123', 'Commerce Admin', 'admin');
  const admin = await User.findById(createdAdmin.id);
  const product = await Product.create({ code: 'RECEIVE-1', sku: 'R-1', name: 'Receiving Item', price: 50, initialQty: 2, reorderLevel: 1, uom: 'pcs', actor: admin });
  const app = express(); app.use(express.json()); app.use('/api/suppliers', require('../src/routes/supplier.routes')); app.use('/api/customers', require('../src/routes/customer.routes'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`; const headers = { Authorization: `Bearer ${generateToken(admin)}`, 'Content-Type': 'application/json' };
  try {
    let response = await fetch(`${base}/api/suppliers`, { method: 'POST', headers, body: JSON.stringify({ name: 'Acme Distribution', phone: '09171234567' }) });
    assert.equal(response.status, 201); const supplier = (await response.json()).data;
    response = await fetch(`${base}/api/suppliers/receipts`, { method: 'POST', headers, body: JSON.stringify({ supplierId: supplier.id, supplierInvoiceNo: 'INV-100', items: [{ productId: product.id, quantity: 5, unitCost: 23.5 }] }) });
    assert.equal(response.status, 201); const receipt = (await response.json()).data; assert.equal(receipt.totalCost, 117.5);
    assert.equal((await get('SELECT stock FROM products WHERE id = ?', [product.id])).stock, 7);
    assert.equal((await get('SELECT quantityDelta FROM inventoryMovements WHERE reference = ?', [receipt.receiptNo])).quantityDelta, 5);
    assert.equal((await get('SELECT supplierInvoiceNo FROM purchaseReceipts WHERE id = ?', [receipt.id])).supplierInvoiceNo, 'INV-100');
    response = await fetch(`${base}/api/customers`, { method: 'POST', headers, body: JSON.stringify({ name: 'Maria Santos', phone: '09998887777' }) });
    assert.equal(response.status, 201); const customer = (await response.json()).data;
    await new Promise((resolve, reject) => db.run(`INSERT INTO transactions (txnNo, userId, cashierName, customerName, subtotal, discountAmount, vatableSales, vatAmount, totalAmount, paymentMethod, branch) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'CASH', ?)`, ['CUST-HISTORY-1', admin.id, admin.name, customer.name, 100, 89.29, 10.71, 100, admin.branch], error => error ? reject(error) : resolve()));
    response = await fetch(`${base}/api/customers?q=Maria`, { headers }); assert.equal((await response.json()).data[0].name, 'Maria Santos');
    response = await fetch(`${base}/api/customers/${customer.id}/history`, { headers }); const history = (await response.json()).data; assert.equal(history.transactions.length, 1);
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
