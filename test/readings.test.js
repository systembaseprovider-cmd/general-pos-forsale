const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'general-pos-readings-test-'));
process.env.POS_DB_PATH = path.join(tempDirectory, 'pos.db');
process.env.POS_BACKUP_DIR = path.join(tempDirectory, 'backups');
process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64');

const db = require('../src/database');
const Reading = require('../src/models/Reading');
const Transaction = require('../src/models/Transaction');
const { generateToken } = require('../src/middleware/auth');
const { getBusinessDate } = require('../src/services/businessDate');

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

function subtractDays(date, days) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() - days);
    return value.toISOString().slice(0, 10);
}

after(async () => {
    await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('Philippine business date rolls over at midnight Asia/Manila', () => {
    assert.equal(getBusinessDate(new Date('2026-01-01T15:59:59.000Z')), '2026-01-01');
    assert.equal(getBusinessDate(new Date('2026-01-01T16:00:00.000Z')), '2026-01-02');
});

test('admin X/Z readings snapshot sales and final Z locks transactions until next business day', async () => {
    await db.ready;
    const admin = await run(
        `INSERT INTO users (username, password, name, role, branch)
         VALUES ('reading-admin', 'unused', 'Reading Admin', 'admin', '01')`
    );
    const firstCashier = await run(
        `INSERT INTO users (username, password, name, role, branch)
         VALUES ('reading-cashier-one', 'unused', 'Cashier One', 'cashier', '01')`
    );
    const secondCashier = await run(
        `INSERT INTO users (username, password, name, role, branch)
         VALUES ('reading-cashier-two', 'unused', 'Cashier Two', 'cashier', '01')`
    );
    const otherBranch = await run(
        `INSERT INTO users (username, password, name, role, branch)
         VALUES ('reading-other-branch', 'unused', 'Other Branch', 'cashier', '02')`
    );
    const businessDate = getBusinessDate();
    const previousUtcDate = subtractDays(businessDate, 1);
    const createSale = async ({ userId, txnNo, total, paymentMethod, createdAt, voidedAt = null, voidedBy = null }) => {
        const sale = await run(
            `INSERT INTO transactions (
                txnNo, userId, cashierName, customerName, subtotal,
                discountAmount, vatableSales, vatAmount, totalAmount,
                paymentMethod, tenderedAmount, changeAmount, branch,
                createdAt, voidedAt, voidedBy
             ) VALUES (?, ?, ?, 'Test Customer', ?, 0, ?, ?, ?, ?, ?, 0, '01', ?, ?, ?)`,
            [
                txnNo,
                userId,
                userId === firstCashier.id ? 'Cashier One' : 'Cashier Two',
                total,
                Number((total / 1.12).toFixed(2)),
                Number((total - total / 1.12).toFixed(2)),
                total,
                paymentMethod,
                total,
                createdAt,
                voidedAt,
                voidedBy
            ]
        );
        const item = await run(
            `INSERT INTO transactionItems (
                transactionId, productId, productCode, productName,
                unitPrice, quantity, lineTotal
             ) VALUES (?, 1, '101', 'Test Product', ?, 1, ?)`,
            [sale.id, total, total]
        );
        return { id: sale.id, itemId: item.id };
    };

    const firstSale = await createSale({
        userId: firstCashier.id,
        txnNo: `01-${businessDate.slice(0, 4)}-81001`,
        total: 100,
        paymentMethod: 'CASH',
        createdAt: `${previousUtcDate} 18:00:00`
    });
    const secondSale = await createSale({
        userId: secondCashier.id,
        txnNo: `01-${businessDate.slice(0, 4)}-81002`,
        total: 200,
        paymentMethod: 'CARD',
        createdAt: `${businessDate} 03:00:00`
    });
    await createSale({
        userId: firstCashier.id,
        txnNo: `01-${businessDate.slice(0, 4)}-81003`,
        total: 50,
        paymentMethod: 'CASH',
        createdAt: `${businessDate} 04:00:00`,
        voidedAt: `${businessDate} 05:00:00`,
        voidedBy: firstCashier.id
    });
    const refundId = crypto.randomUUID();
    await run(
        `INSERT INTO refunds (
            requestId, requestHash, transactionId, userId, branch,
            refundAmount, reason, createdAt
         ) VALUES (?, ?, ?, ?, '01', 20, 'Test partial refund', ?)`,
        [refundId, crypto.randomBytes(32).toString('hex'), secondSale.id, firstCashier.id, `${businessDate} 06:00:00`]
    );
    const insertedRefund = await get('SELECT id FROM refunds WHERE requestId = ?', [refundId]);
    await run(
        `INSERT INTO refundItems (refundId, transactionItemId, quantity, refundAmount)
         VALUES (?, ?, 1, 20)`,
        [insertedRefund.id, secondSale.itemId]
    );

    const firstX = await Reading.getXReading('01', businessDate, firstCashier.id);
    assert.equal(firstX.transactionCount, 1);
    assert.equal(firstX.grossSales, 100);
    assert.equal(firstX.refundTotal, 20);
    assert.equal(firstX.voidCount, 1);
    assert.equal(firstX.voidedAmount, 50);
    assert.equal(firstX.netSales, 80);

    const preview = await Reading.getZReading('01', businessDate);
    assert.equal(preview.closed, false);
    assert.equal(preview.transactionCount, 2);
    assert.equal(preview.grossSales, 300);
    assert.equal(preview.refundTotal, 20);
    assert.equal(preview.voidCount, 1);
    assert.equal(preview.voidedAmount, 50);
    assert.equal(preview.netSales, 280);
    assert.deepEqual(
        preview.paymentBreakdown.map(row => [row.paymentMethod, row.grossSales, row.refundTotal, row.netSales]),
        [['CARD', 200, 20, 180], ['CASH', 100, 0, 100]]
    );
    assert.equal(preview.cashierBreakdown.find(row => row.userId === firstCashier.id).netSales, 80);
    assert.equal(preview.cashierBreakdown.find(row => row.userId === secondCashier.id).netSales, 200);

    const adminToken = generateToken({
        id: admin.id,
        username: 'reading-admin',
        name: 'Reading Admin',
        role: 'admin',
        branch: '01',
        tokenVersion: 0
    });
    const cashierToken = generateToken({
        id: firstCashier.id,
        username: 'reading-cashier-one',
        name: 'Cashier One',
        role: 'cashier',
        branch: '01',
        tokenVersion: 0
    });
    const app = express();
    app.use(express.json());
    app.use('/api/readings', require('../src/routes/reading.routes'));
    app.use('/api/transactions', require('../src/routes/transaction.routes'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/readings`;

    try {
        const cashierRequest = await fetch(
            `${baseUrl}/x?date=${businessDate}&userId=${firstCashier.id}`,
            { headers: { Authorization: `Bearer ${cashierToken}` } }
        );
        assert.equal(cashierRequest.status, 403);

        const xRequest = await fetch(
            `${baseUrl}/x?date=${businessDate}&userId=${firstCashier.id}`,
            { headers: { Authorization: `Bearer ${adminToken}` } }
        );
        assert.equal(xRequest.status, 200);
        assert.equal((await xRequest.json()).data.netSales, 80);

        const wrongBranchUser = await fetch(
            `${baseUrl}/x?date=${businessDate}&userId=${otherBranch.id}`,
            { headers: { Authorization: `Bearer ${adminToken}` } }
        );
        assert.equal(wrongBranchUser.status, 404);

        const missingConfirmation = await fetch(`${baseUrl}/z/close`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${adminToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ confirmClose: false })
        });
        assert.equal(missingConfirmation.status, 400);

        const cashierClose = await fetch(`${baseUrl}/z/close`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${cashierToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ confirmClose: true })
        });
        assert.equal(cashierClose.status, 403);

        const closedResponse = await fetch(`${baseUrl}/z/close`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${adminToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ confirmClose: true })
        });
        assert.equal(closedResponse.status, 201);
        const closed = await closedResponse.json();
        assert.equal(closed.data.closed, true);
        assert.equal(closed.data.netSales, 280);
        assert.equal(
            (await get(
                "SELECT COUNT(*) AS count FROM auditLogs WHERE eventType = 'BUSINESS_DAY_CLOSED'"
            )).count,
            1
        );

        const zRead = await fetch(`${baseUrl}/z?date=${businessDate}`, {
            headers: { Authorization: `Bearer ${adminToken}` }
        });
        assert.equal(zRead.status, 200);
        assert.equal((await zRead.json()).data.closed, true);

        const repeatedClose = await fetch(`${baseUrl}/z/close`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${adminToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ confirmClose: true })
        });
        assert.equal(repeatedClose.status, 200);
        assert.equal((await repeatedClose.json()).data.alreadyClosed, true);

        const product = await get('SELECT id, price FROM products ORDER BY id LIMIT 1');
        const nextTxnNo = await Transaction.getNextTxnNo('01');
        const closedSaleResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/transactions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${adminToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                txnNo: nextTxnNo,
                customerName: 'After Close',
                items: [{ productId: product.id, quantity: 1 }],
                discountAmount: 0,
                expectedTotal: product.price,
                tenderedAmount: product.price,
                changeAmount: 0,
                paymentMethod: 'CASH',
                referenceNo: ''
            })
        });
        assert.equal(closedSaleResponse.status, 409);
        assert.equal((await closedSaleResponse.json()).code, 'BUSINESS_DAY_CLOSED');
    } finally {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }

    const nextBusinessDate = getBusinessDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
    assert.equal(await Reading.isBusinessDayClosed('01', businessDate), true);
    assert.equal(await Reading.isBusinessDayClosed('01', nextBusinessDate), false);
    const product = await get('SELECT id, price FROM products ORDER BY id LIMIT 1');
    const nextTxnNo = await Transaction.getNextTxnNo('01');
    const originalDate = global.Date;
    const nextBusinessInstant = new originalDate(`${nextBusinessDate}T12:00:00+08:00`);
    global.Date = class extends originalDate {
        constructor(...args) {
            super(...(args.length ? args : [nextBusinessInstant.getTime()]));
        }

        static now() {
            return nextBusinessInstant.getTime();
        }
    };
    try {
        const nextDaySale = await Transaction.create({
            txnNo: nextTxnNo,
            userId: firstCashier.id,
            cashierName: 'Cashier One',
            customerName: 'Next Business Day',
            branch: '01',
            items: [{ productId: product.id, quantity: 1 }],
            discountAmount: 0,
            expectedTotal: product.price,
            tenderedAmount: product.price,
            changeAmount: 0,
            paymentMethod: 'CASH',
            referenceNo: ''
        });
        assert.ok(nextDaySale.id);
        assert.equal((await get('SELECT COUNT(*) AS count FROM transactions')).count, 4);
    } finally {
        global.Date = originalDate;
    }
    await assert.rejects(
        Transaction.refund({
            transactionId: secondSale.id,
            requestId: crypto.randomUUID(),
            userId: firstCashier.id,
            cashierName: 'Cashier One',
            branch: '01',
            reason: 'Refund after close',
            items: [{ transactionItemId: secondSale.itemId, quantity: 1 }]
        }),
        error => error.code === 'BUSINESS_DAY_CLOSED'
    );
    await assert.rejects(
        Transaction.voidSale({
            transactionId: firstSale.id,
            requestId: crypto.randomUUID(),
            userId: firstCashier.id,
            cashierName: 'Cashier One',
            branch: '01',
            reason: 'Void after close'
        }),
        error => error.code === 'BUSINESS_DAY_CLOSED'
    );
    assert.equal((await get('SELECT COUNT(*) AS count FROM transactions')).count, 4);
    assert.equal((await get('SELECT COUNT(*) AS count FROM refunds')).count, 1);
});
