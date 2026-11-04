const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'general-pos-history-test-'));
process.env.POS_DB_PATH = path.join(tempDirectory, 'pos.db');
process.env.POS_BACKUP_DIR = path.join(tempDirectory, 'backups');
process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64');

const db = require('../src/database');
const User = require('../src/models/User');
const Transaction = require('../src/models/Transaction');
const { generateToken } = require('../src/middleware/auth');

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(error) {
            if (error) return reject(error);
            resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

after(async () => {
    await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('recent sales reload from SQLite with scope, legacy receipt number, and next sequence', async () => {
    await db.ready;
    const cashier = await run(
        `INSERT INTO users (username, password, name, role, branch, modulePermissions)
         VALUES ('history-cashier', 'unused', 'History Cashier', 'cashier', '01',
                 '{"pos":true,"inventory":false,"products":false,"reports":false}')`
    );
    const otherCashier = await run(
        `INSERT INTO users (username, password, name, role, branch, modulePermissions)
         VALUES ('other-history-cashier', 'unused', 'Other History Cashier', 'cashier', '02',
                 '{"pos":true,"inventory":false,"products":false,"reports":false}')`
    );
    const year = new Date().getFullYear();
    const transactions = [
        {
            txnNo: `01-${year}-00030`,
            userId: cashier.id,
            branch: '01',
            createdAt: `${year}-01-01 08:00:00`
        },
        {
            txnNo: `01-${year}-00006`,
            userId: cashier.id,
            branch: '01',
            createdAt: `${year}-11-03 15:00:00`
        },
        {
            txnNo: `01-${year}-00001`,
            userId: cashier.id,
            branch: '01',
            createdAt: `${year}-01-01 07:00:00`
        },
        {
            txnNo: `02-${year}-00040`,
            userId: otherCashier.id,
            branch: '02',
            createdAt: `${year}-11-03 16:00:00`
        }
    ];
    const savedIds = [];
    for (const transaction of transactions) {
        const inserted = await run(
            `INSERT INTO transactions (
                txnNo, userId, cashierName, customerName, subtotal,
                discountAmount, vatableSales, vatAmount, totalAmount,
                paymentMethod, tenderedAmount, changeAmount, branch, createdAt
             ) VALUES (?, ?, 'History Cashier', 'Test Customer', 112, 0, 100, 12, 112,
                       'CASH', 112, 0, ?, ?)`,
            [transaction.txnNo, transaction.userId, transaction.branch, transaction.createdAt]
        );
        savedIds.push(inserted.id);
    }

    await run(
        `INSERT INTO legacyTransactionImports (
            sourceFingerprint, sourcePath, sourceTransactionId,
            targetTransactionId, originalTxnNo, importedTxnNo
         ) VALUES ('test-fingerprint', 'test-source.db', 1, ?, ?, ?)`,
        [savedIds[0], `01-${year}-00001`, `01-${year}-00030`]
    );

    assert.equal(await Transaction.getNextTxnNo('01', year), `01-${year}-00031`);

    const user = await User.findById(cashier.id);
    const token = generateToken(user);
    const app = express();
    app.use('/api/transactions', require('../src/routes/transaction.routes'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });

    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/transactions/recent?limit=10`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.success, true);
        assert.equal(result.count, 3);
        assert.deepEqual(result.data.map(transaction => transaction.txnNo), [
            `01-${year}-00006`,
            `01-${year}-00030`,
            `01-${year}-00001`
        ]);
        assert.equal(result.data[1].originalTxnNo, `01-${year}-00001`);
        assert.equal(result.data.some(transaction => transaction.branch === '02'), false);

        const ambiguousReceipt = await fetch(
            `http://127.0.0.1:${server.address().port}/api/transactions/txn/01-${year}-00001`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        assert.equal(ambiguousReceipt.status, 409);

        const importedReceipt = await fetch(
            `http://127.0.0.1:${server.address().port}/api/transactions/txn/01-${year}-00030`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        assert.equal(importedReceipt.status, 200);
        assert.equal((await importedReceipt.json()).data.originalTxnNo, `01-${year}-00001`);
    } finally {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
});
