const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const { after, test } = require('node:test');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'general-pos-test-'));
process.env.POS_DB_PATH = path.join(tempDirectory, 'pos.db');
process.env.POS_BACKUP_DIR = path.join(tempDirectory, 'backups');
process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64');

const db = require('../src/database');
const Transaction = require('../src/models/Transaction');
const Product = require('../src/models/Product');
const User = require('../src/models/User');
const AppSettings = require('../src/models/AppSettings');
const { generateToken } = require('../src/middleware/auth');
const { hasModulePermission } = require('../src/services/modulePermissions');
const { createBackup, pruneBackups } = require('../src/services/backup');

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(error) {
            if (error) return reject(error);
            resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
    });
}

after(async () => {
    await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('partial refunds restore stock once, enforce remaining quantities, and update reports', async () => {
    await db.ready;
    await run(
        `INSERT INTO users (username, password, name, role, branch)
         VALUES ('refund-test', 'unused', 'Refund Tester', 'cashier', '01')`
    );
    const user = await get("SELECT id FROM users WHERE username = 'refund-test'");
    const product = await get('SELECT id, code, price, stock FROM products ORDER BY id LIMIT 1');
    const startingStock = product.stock;
    const txnNo = `01-${new Date().getFullYear()}-98761`;
    const unitPriceCents = Math.round(product.price * 100);
    const sale = await Transaction.create({
        txnNo,
        userId: user.id,
        cashierName: 'Refund Tester',
        customerName: 'Test Customer',
        branch: '01',
        items: [{ productId: product.id, quantity: 3 }],
        discountAmount: Number((product.price * 3 * 0.1).toFixed(2)),
        discountReason: 'Test promotion refund',
        discountType: 'PROMO',
        expectedTotal: Number((product.price * 3 * 0.9).toFixed(2)),
        tenderedAmount: Number((product.price * 3 * 0.9).toFixed(2)),
        changeAmount: 0,
        paymentMethod: 'CASH',
        referenceNo: ''
    });
    assert.equal(
        (await get(
            "SELECT quantityDelta FROM inventoryMovements WHERE productId = ? AND movementType = 'SALE' AND reference = ?",
            [product.id, txnNo]
        )).quantityDelta,
        -3
    );

    const preview = await Transaction.getRefundPreview(txnNo, '01');
    assert.equal(preview.items[0].refundableQuantity, 3);
    assert.equal(preview.items[0].refundableAmount, Number((unitPriceCents * 2.7 / 100).toFixed(2)));

    const firstRequest = {
        transactionId: sale.id,
        requestId: crypto.randomUUID(),
        userId: user.id,
        cashierName: 'Refund Tester',
        branch: '01',
        reason: 'One item returned',
        items: [{ transactionItemId: preview.items[0].id, quantity: 1 }]
    };
    const firstRefund = await Transaction.refund(firstRequest);
    assert.equal(firstRefund.refundAmount, preview.items[0].refundableAmount / 3);

    const repeatedRefund = await Transaction.refund(firstRequest);
    assert.equal(repeatedRefund.idempotent, true);
    assert.equal((await get('SELECT stock FROM products WHERE id = ?', [product.id])).stock, startingStock - 2);

    const remaining = await Transaction.getRefundPreview(txnNo, '01');
    const finalRefund = await Transaction.refund({
        ...firstRequest,
        requestId: crypto.randomUUID(),
        reason: 'Remaining items returned',
        items: [{ transactionItemId: remaining.items[0].id, quantity: 2 }]
    });
    assert.equal(
        Math.round((firstRefund.refundAmount + finalRefund.refundAmount) * 100),
        Math.round(sale.totalAmount * 100)
    );
    assert.equal((await get('SELECT stock FROM products WHERE id = ?', [product.id])).stock, startingStock);
    assert.equal(
        (await get(
            "SELECT SUM(quantityDelta) AS quantity FROM inventoryMovements WHERE productId = ? AND movementType = 'REFUND' AND reference = ?",
            [product.id, txnNo]
        )).quantity,
        3
    );

    await assert.rejects(
        Transaction.refund({
            ...firstRequest,
            requestId: crypto.randomUUID(),
            reason: 'Extra item return',
            items: [{ transactionItemId: preview.items[0].id, quantity: 1 }]
        }),
        /exceeds the remaining sold quantity/
    );
    await assert.rejects(
        Transaction.voidSale({
            transactionId: sale.id,
            requestId: crypto.randomUUID(),
            userId: user.id,
            cashierName: 'Refund Tester',
            branch: '01',
            reason: 'Void after refund'
        }),
        /recorded refund cannot be voided/
    );

    const today = new Date().toISOString().slice(0, 10);
    const summary = await Transaction.getSalesSummary(today, today, '01', user.id);
    assert.equal(Math.round(summary.totalSales * 100), 0);
    const topProducts = await Transaction.getTopProducts(10, '01', user.id);
    assert.equal(topProducts.some(item => item.productCode === product.code), false);
    assert.equal(
        (await get("SELECT COUNT(*) AS count FROM auditLogs WHERE eventType = 'TRANSACTION_REFUNDED'")).count,
        2
    );
});

test('completed-sale voids restore stock once, reject refunded sales, and exclude voided sales from reports', async () => {
    await db.ready;
    const user = await get("SELECT id FROM users WHERE username = 'refund-test'");
    const product = await get('SELECT id, code, price, stock FROM products ORDER BY id LIMIT 1');
    const startingStock = product.stock;
    const unitPriceCents = Math.round(product.price * 100);
    const txnNo = `01-${new Date().getFullYear()}-98762`;
    const sale = await Transaction.create({
        txnNo,
        userId: user.id,
        cashierName: 'Refund Tester',
        customerName: 'Void Test Customer',
        branch: '01',
        items: [{ productId: product.id, quantity: 2 }],
        discountAmount: 0,
        expectedTotal: unitPriceCents * 2 / 100,
        tenderedAmount: unitPriceCents * 2 / 100,
        changeAmount: 0,
        paymentMethod: 'CASH',
        referenceNo: ''
    });

    const today = new Date().toISOString().slice(0, 10);
    const summaryBeforeVoid = await Transaction.getSalesSummary(today, today, '01', user.id);
    const preview = await Transaction.getVoidPreview(txnNo, '01');
    assert.equal(preview.canVoid, true);
    assert.equal(preview.refundCount, 0);

    const voidRequest = {
        transactionId: sale.id,
        requestId: crypto.randomUUID(),
        userId: user.id,
        cashierName: 'Refund Tester',
        branch: '01',
        reason: 'Duplicate sale entry'
    };
    const voidResult = await Transaction.voidSale(voidRequest);
    assert.equal(voidResult.idempotent, false);
    assert.equal((await get('SELECT stock FROM products WHERE id = ?', [product.id])).stock, startingStock);
    assert.equal(
        (await get(
            "SELECT quantityDelta FROM inventoryMovements WHERE productId = ? AND movementType = 'VOID' AND reference = ?",
            [product.id, txnNo]
        )).quantityDelta,
        2
    );

    const retry = await Transaction.voidSale(voidRequest);
    assert.equal(retry.idempotent, true);
    await assert.rejects(
        Transaction.voidSale({ ...voidRequest, requestId: crypto.randomUUID() }),
        /already been voided/
    );
    const voidedTransaction = await Transaction.getById(sale.id, '01');
    assert.ok(voidedTransaction.voidedAt);
    assert.equal(voidedTransaction.voidReason, 'Duplicate sale entry');
    assert.equal((await Transaction.getVoidPreview(txnNo, '01')).canVoid, false);

    const saleItem = await get('SELECT id FROM transactionItems WHERE transactionId = ?', [sale.id]);
    await assert.rejects(
        Transaction.refund({
            transactionId: sale.id,
            requestId: crypto.randomUUID(),
            userId: user.id,
            cashierName: 'Refund Tester',
            branch: '01',
            reason: 'Refund voided sale',
            items: [{ transactionItemId: saleItem.id, quantity: 1 }]
        }),
        /voided transaction cannot be refunded/
    );

    const summaryAfterVoid = await Transaction.getSalesSummary(today, today, '01', user.id);
    assert.equal(summaryAfterVoid.transactionCount, summaryBeforeVoid.transactionCount - 1);
    assert.equal(
        Math.round(summaryAfterVoid.totalSales * 100),
        Math.round((summaryBeforeVoid.totalSales - sale.totalAmount) * 100)
    );
    assert.equal(
        (await get("SELECT COUNT(*) AS count FROM auditLogs WHERE eventType = 'TRANSACTION_VOIDED'")).count,
        1
    );
});

test('admin product, inventory, user permission, and branding workflows are audited and validated', async () => {
    await db.ready;
    const cashier = await User.create('module-cashier', 'cashier-pass-123', 'Module Cashier');
    const firstAdmin = await User.create('module-admin1', 'admin-pass-1234', 'Module Admin One', 'admin');
    const secondAdmin = await User.create('module-admin2', 'admin-pass-5678', 'Module Admin Two', 'admin');

    assert.equal(hasModulePermission(cashier, 'pos'), true);
    assert.equal(hasModulePermission(cashier, 'inventory'), false);
    assert.equal(hasModulePermission(cashier, 'products'), false);
    assert.equal(hasModulePermission(firstAdmin, 'inventory'), true);

    const managedCashier = await User.updateManaged({
        id: cashier.id,
        branch: cashier.branch,
        actorId: firstAdmin.id,
        name: cashier.name,
        username: cashier.username,
        role: 'cashier',
        isActive: true,
        modulePermissions: { pos: true, inventory: true, products: false, reports: false }
    });
    assert.equal(managedCashier.modulePermissions.inventory, true);
    assert.equal(hasModulePermission(managedCashier, 'reports'), false);
    await assert.rejects(
        User.updateManaged({
            id: firstAdmin.id,
            branch: firstAdmin.branch,
            actorId: firstAdmin.id,
            name: firstAdmin.name,
            username: firstAdmin.username,
            role: 'cashier',
            isActive: true,
            modulePermissions: {}
        }),
        /cannot remove your own administrator access/
    );

    await User.updateManaged({
        id: firstAdmin.id,
        branch: firstAdmin.branch,
        actorId: cashier.id,
        name: firstAdmin.name,
        username: firstAdmin.username,
        role: 'admin',
        isActive: false,
        modulePermissions: {}
    });
    await assert.rejects(
        User.updateManaged({
            id: secondAdmin.id,
            branch: secondAdmin.branch,
            actorId: cashier.id,
            name: secondAdmin.name,
            username: secondAdmin.username,
            role: 'admin',
            isActive: false,
            modulePermissions: {}
        }),
        /last active administrator/
    );

    const barcode = `ADMIN-TEST-${crypto.randomUUID()}`;
    const product = await Product.create({
        code: barcode,
        sku: `SKU-${crypto.randomUUID()}`,
        name: 'Admin Module Test Item',
        price: 12.5,
        initialQty: 4,
        reorderLevel: 3,
        uom: 'box',
        actor: cashier
    });
    assert.equal(product.stock, 4);
    assert.equal(
        (await get(
            "SELECT quantityDelta FROM inventoryMovements WHERE productId = ? AND movementType = 'OPENING'",
            [product.id]
        )).quantityDelta,
        4
    );
    await Product.update(product.id, { reorderLevel: 5, sku: product.sku }, cashier);
    const productUpdateAudit = await get(
        "SELECT userId, details FROM auditLogs WHERE eventType = 'PRODUCT_UPDATED' AND productId = ?",
        [product.id]
    );
    assert.equal(productUpdateAudit.userId, cashier.id);
    assert.equal(JSON.parse(productUpdateAudit.details).changedFields.reorderLevel.from, 3);
    assert.equal(JSON.parse(productUpdateAudit.details).changedFields.reorderLevel.to, 5);
    assert.equal(
        (await Product.getLowStock(0)).some(item => item.id === product.id),
        true
    );
    await assert.rejects(Product.update(product.id, { stock: 100 }), /Stock cannot be edited/);
    await Product.updateStock(product.id, 2, 'Received supplier stock', cashier);
    await Product.updateStock(product.id, -1, 'Damaged item removal', cashier);
    await assert.rejects(
        Product.updateStock(product.id, -6, 'Attempt to over-remove stock', cashier),
        /would make stock negative/
    );
    assert.equal((await Product.getById(product.id)).stock, 5);
    const movements = await Product.getMovements({ branch: cashier.branch, productId: product.id, limit: 20, offset: 0 });
    assert.deepEqual(
        movements.map(movement => movement.movementType).sort(),
        ['MANUAL_ADD', 'MANUAL_REMOVE', 'OPENING']
    );
    await Product.deactivate(product.id, cashier);
    assert.equal(await Product.getById(product.id), null);
    const productDeactivationAudit = await get(
        "SELECT userId, reason FROM auditLogs WHERE eventType = 'PRODUCT_DEACTIVATED' AND productId = ?",
        [product.id]
    );
    assert.equal(productDeactivationAudit.userId, cashier.id);
    assert.equal(productDeactivationAudit.reason, 'Product deactivated');

    const settings = await AppSettings.update({
        appName: 'Admin Test POS',
        address: '1 Test Street',
        phone: '555-0100',
        tin: 'TIN-TEST',
        receiptFooter: 'Thank you'
    });
    assert.equal(settings.appName, 'Admin Test POS');
    assert.equal((await AppSettings.get()).address, '1 Test Street');
    assert.deepEqual(await AppSettings.getPublic(), {
        appName: 'Admin Test POS',
        logoDataUrl: null
    });
    await assert.rejects(
        AppSettings.update({ logoDataUrl: 'data:image/png;base64,SGVsbG8=' }),
        /contents do not match/
    );
    assert.equal(
        (await get("SELECT COUNT(*) AS count FROM auditLogs WHERE eventType = 'USER_CREATED'")).count,
        3
    );
});

test('public branding omits receipt details and full branding requires authentication', async () => {
    await db.ready;
    const user = await User.findById((await get("SELECT id FROM users WHERE username = 'module-cashier'")).id);
    const app = express();
    app.use('/api/settings', require('../src/routes/settings.routes'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });

    try {
        const baseUrl = `http://127.0.0.1:${server.address().port}/api/settings`;
        const publicResponse = await fetch(`${baseUrl}/public-branding`);
        assert.equal(publicResponse.status, 200);
        const publicResult = await publicResponse.json();
        assert.deepEqual(Object.keys(publicResult.data).sort(), ['appName', 'logoDataUrl']);

        const unauthenticatedResponse = await fetch(`${baseUrl}/branding`);
        assert.equal(unauthenticatedResponse.status, 401);

        const authenticatedResponse = await fetch(`${baseUrl}/branding`, {
            headers: { Authorization: `Bearer ${generateToken(user)}` }
        });
        assert.equal(authenticatedResponse.status, 200);
        const authenticatedResult = await authenticatedResponse.json();
        assert.equal(authenticatedResult.data.tin, 'TIN-TEST');
        assert.equal(authenticatedResult.data.address, '1 Test Street');
    } finally {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
});

test('daily database backups are valid and old backup files are pruned', async () => {
    await db.ready;
    const backupPath = await createBackup(db);
    assert.equal(fs.statSync(backupPath).size > 0, true);
    const integrity = await new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(backupPath, sqlite3.OPEN_READONLY, error => {
            if (error) return reject(error);
            connection.get('PRAGMA integrity_check', (integrityError, row) => {
                connection.close(closeError => {
                    if (integrityError) return reject(integrityError);
                    if (closeError) return reject(closeError);
                    resolve(row.integrity_check);
                });
            });
        });
    });
    assert.equal(integrity, 'ok');

    const oldBackup = path.join(process.env.POS_BACKUP_DIR, 'pos-backup-old.db');
    fs.writeFileSync(oldBackup, 'expired');
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldBackup, oldDate, oldDate);
    pruneBackups();
    assert.equal(fs.existsSync(oldBackup), false);
    assert.equal(fs.existsSync(backupPath), true);
});
