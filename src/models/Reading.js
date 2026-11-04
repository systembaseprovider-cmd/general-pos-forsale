const sqlite3 = require('sqlite3').verbose();
const db = require('../database');
const AuditLog = require('./AuditLog');
const { BUSINESS_TIME_ZONE, getBusinessDate } = require('../services/businessDate');

function all(connection, sql, params = []) {
    return new Promise((resolve, reject) => {
        connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
    });
}

function get(connection, sql, params = []) {
    return new Promise((resolve, reject) => {
        connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });
}

function run(connection, sql, params = []) {
    return new Promise((resolve, reject) => {
        connection.run(sql, params, function(error) {
            if (error) return reject(error);
            resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

function close(connection) {
    return new Promise((resolve, reject) => {
        connection.close(error => error ? reject(error) : resolve());
    });
}

function businessDateClause(column) {
    return `date(${column}, '+8 hours') = ?`;
}

async function buildSnapshot(connection, branch, businessDate, userId) {
    const userFilter = userId === undefined ? '' : ' AND userId = ?';
    const userValues = userId === undefined ? [businessDate, branch] : [businessDate, branch, userId];
    const sales = await get(
        connection,
        `SELECT COUNT(*) AS transactionCount,
                COALESCE(SUM(totalAmount), 0) AS grossSales,
                COALESCE(SUM(discountAmount), 0) AS discountTotal
         FROM transactions
         WHERE ${businessDateClause('createdAt')} AND branch = ?
           AND voidedAt IS NULL${userFilter}`,
        userValues
    );

    const refundFilter = userId === undefined ? '' : ' AND refunds.userId = ?';
    const refundValues = userId === undefined
        ? [businessDate, branch]
        : [businessDate, branch, userId];
    const refunds = await get(
        connection,
        `SELECT COUNT(*) AS refundCount,
                COALESCE(SUM(refundAmount), 0) AS refundTotal
         FROM refunds
         WHERE ${businessDateClause('createdAt')} AND branch = ?${refundFilter}`,
        refundValues
    );

    const voidUserFilter = userId === undefined ? '' : ' AND voidedBy = ?';
    const voidValues = userId === undefined
        ? [businessDate, branch]
        : [businessDate, branch, userId];
    const voids = await get(
        connection,
        `SELECT COUNT(*) AS voidCount,
                COALESCE(SUM(totalAmount), 0) AS voidedAmount
         FROM transactions
         WHERE ${businessDateClause('transactions.voidedAt')} AND transactions.branch = ?
           AND transactions.voidedAt IS NOT NULL${voidUserFilter}`,
        voidValues
    );

    const paymentUserFilter = userId === undefined ? '' : ' AND userId = ?';
    const paymentValues = userId === undefined
        ? [businessDate, branch]
        : [businessDate, branch, userId];
    const paymentSales = await all(
        connection,
        `SELECT paymentMethod, COALESCE(SUM(totalAmount), 0) AS grossSales
         FROM transactions
         WHERE ${businessDateClause('createdAt')} AND branch = ?
           AND voidedAt IS NULL${paymentUserFilter}
         GROUP BY paymentMethod`,
        paymentValues
    );

    const paymentRefundUserFilter = userId === undefined ? '' : ' AND refunds.userId = ?';
    const paymentRefundValues = userId === undefined
        ? [businessDate, branch]
        : [businessDate, branch, userId];
    const paymentRefunds = await all(
        connection,
        `SELECT transactions.paymentMethod,
                COALESCE(SUM(refunds.refundAmount), 0) AS refundTotal
         FROM refunds
         INNER JOIN transactions ON transactions.id = refunds.transactionId
         WHERE ${businessDateClause('refunds.createdAt')}
           AND refunds.branch = ?${paymentRefundUserFilter}
         GROUP BY transactions.paymentMethod`,
        paymentRefundValues
    );

    const payments = new Map();
    for (const row of paymentSales) {
        payments.set(row.paymentMethod, {
            paymentMethod: row.paymentMethod,
            grossSales: Number(row.grossSales),
            refundTotal: 0
        });
    }
    for (const row of paymentRefunds) {
        const method = payments.get(row.paymentMethod) || {
            paymentMethod: row.paymentMethod,
            grossSales: 0,
            refundTotal: 0
        };
        method.refundTotal = Number(row.refundTotal);
        payments.set(row.paymentMethod, method);
    }
    const paymentBreakdown = [...payments.values()]
        .map(row => ({ ...row, netSales: row.grossSales - row.refundTotal }))
        .sort((a, b) => b.netSales - a.netSales);

    let cashierBreakdown = [];
    if (userId === undefined) {
        const [cashierSales, cashierRefunds, cashierVoids] = await Promise.all([
            all(
                connection,
                `SELECT userId, cashierName AS name, COUNT(*) AS transactionCount,
                        COALESCE(SUM(totalAmount), 0) AS grossSales,
                        COALESCE(SUM(discountAmount), 0) AS discountTotal
                 FROM transactions
                 WHERE ${businessDateClause('createdAt')} AND branch = ?
                   AND voidedAt IS NULL
                 GROUP BY userId, cashierName`,
                [businessDate, branch]
            ),
            all(
                connection,
                `SELECT refunds.userId, users.name, COUNT(*) AS refundCount,
                        COALESCE(SUM(refunds.refundAmount), 0) AS refundTotal
                 FROM refunds
                 INNER JOIN users ON users.id = refunds.userId
                 WHERE ${businessDateClause('refunds.createdAt')} AND refunds.branch = ?
                 GROUP BY refunds.userId, users.name`,
                [businessDate, branch]
            ),
            all(
                connection,
                `SELECT voidedBy AS userId, users.name, COUNT(*) AS voidCount,
                        COALESCE(SUM(totalAmount), 0) AS voidedAmount
                 FROM transactions
                 LEFT JOIN users ON users.id = transactions.voidedBy
                 WHERE ${businessDateClause('transactions.voidedAt')} AND transactions.branch = ?
                   AND transactions.voidedAt IS NOT NULL
                 GROUP BY voidedBy, users.name`,
                [businessDate, branch]
            )
        ]);
        const cashiers = new Map();
        for (const row of cashierSales) {
            cashiers.set(row.userId, {
                userId: row.userId,
                name: row.name,
                transactionCount: Number(row.transactionCount),
                grossSales: Number(row.grossSales),
                discountTotal: Number(row.discountTotal),
                refundCount: 0,
                refundTotal: 0,
                voidCount: 0,
                voidedAmount: 0
            });
        }
        for (const row of cashierRefunds) {
            const cashier = cashiers.get(row.userId) || {
                userId: row.userId,
                name: row.name,
                transactionCount: 0,
                grossSales: 0,
                discountTotal: 0,
                refundCount: 0,
                refundTotal: 0,
                voidCount: 0,
                voidedAmount: 0
            };
            cashier.refundCount = Number(row.refundCount);
            cashier.refundTotal = Number(row.refundTotal);
            cashiers.set(row.userId, cashier);
        }
        for (const row of cashierVoids) {
            const cashier = cashiers.get(row.userId) || {
                userId: row.userId,
                name: row.name || 'Unknown user',
                transactionCount: 0,
                grossSales: 0,
                discountTotal: 0,
                refundCount: 0,
                refundTotal: 0,
                voidCount: 0,
                voidedAmount: 0
            };
            cashier.voidCount = Number(row.voidCount);
            cashier.voidedAmount = Number(row.voidedAmount);
            cashiers.set(row.userId, cashier);
        }
        cashierBreakdown = [...cashiers.values()]
            .map(row => ({ ...row, netSales: row.grossSales - row.refundTotal }))
            .sort((a, b) => b.netSales - a.netSales || a.name.localeCompare(b.name));
    }

    return {
        branch,
        businessDate,
        timeZone: BUSINESS_TIME_ZONE,
        transactionCount: Number(sales.transactionCount),
        grossSales: Number(sales.grossSales),
        discountTotal: Number(sales.discountTotal),
        refundCount: Number(refunds.refundCount),
        refundTotal: Number(refunds.refundTotal),
        voidCount: Number(voids.voidCount),
        voidedAmount: Number(voids.voidedAmount),
        netSales: Number(sales.grossSales) - Number(refunds.refundTotal),
        paymentBreakdown,
        cashierBreakdown
    };
}

function createBusinessDayClosedError(branch, businessDate) {
    const error = new Error(`The business day for ${branch} is closed. New sales, refunds, and voids resume tomorrow.`);
    error.code = 'BUSINESS_DAY_CLOSED';
    error.businessDate = businessDate;
    return error;
}

class Reading {
    static getBusinessDate(date) {
        return getBusinessDate(date);
    }

    static async isBusinessDayClosed(branch, businessDate = getBusinessDate()) {
        const closure = await get(
            db,
            'SELECT 1 AS closed FROM dailyClosures WHERE branch = ? AND businessDate = ?',
            [branch, businessDate]
        );
        return Boolean(closure);
    }

    static async assertBusinessDayOpen(connection, branch, businessDate = getBusinessDate()) {
        const closure = await get(
            connection,
            'SELECT 1 AS closed FROM dailyClosures WHERE branch = ? AND businessDate = ?',
            [branch, businessDate]
        );
        if (closure) throw createBusinessDayClosedError(branch, businessDate);
    }

    static async getXReading(branch, businessDate, userId) {
        const user = await get(
            db,
            'SELECT id, username, name, role, branch FROM users WHERE id = ? AND branch = ?',
            [userId, branch]
        );
        if (!user) return null;
        const snapshot = await buildSnapshot(db, branch, businessDate, userId);
        return { ...snapshot, user: { id: user.id, username: user.username, name: user.name } };
    }

    static async getZReading(branch, businessDate) {
        const closure = await get(
            db,
            `SELECT id, branch, businessDate, closedBy, closedByName, closedAt, snapshotJson
             FROM dailyClosures WHERE branch = ? AND businessDate = ?`,
            [branch, businessDate]
        );
        if (closure) {
            let snapshot;
            try {
                snapshot = JSON.parse(closure.snapshotJson);
            } catch (error) {
                console.error('Stored Z-reading snapshot is invalid:', error);
                throw new Error('Stored Z-reading snapshot could not be read');
            }
            return { ...snapshot, closed: true, closure };
        }
        const snapshot = await buildSnapshot(db, branch, businessDate);
        return { ...snapshot, closed: false, closure: null };
    }

    static closeBusinessDay(branch, closedBy, closedByName, businessDate = getBusinessDate()) {
        return new Promise((resolve, reject) => {
            const connection = new sqlite3.Database(db.databasePath, async openError => {
                if (openError) return reject(openError);
                connection.configure('busyTimeout', 5000);
                let transactionStarted = false;
                let transactionFinished = false;
                try {
                    await run(connection, 'PRAGMA foreign_keys = ON');
                    await run(connection, 'BEGIN IMMEDIATE TRANSACTION');
                    transactionStarted = true;
                    const existing = await get(
                        connection,
                        `SELECT id, branch, businessDate, closedBy, closedByName, closedAt, snapshotJson
                         FROM dailyClosures WHERE branch = ? AND businessDate = ?`,
                        [branch, businessDate]
                    );
                    if (existing) {
                        await run(connection, 'COMMIT');
                        transactionFinished = true;
                        const snapshot = JSON.parse(existing.snapshotJson);
                        await close(connection);
                        return resolve({ ...snapshot, closed: true, alreadyClosed: true, closure: existing });
                    }

                    const snapshot = await buildSnapshot(connection, branch, businessDate);
                    const serializedSnapshot = JSON.stringify(snapshot);
                    const insert = await run(
                        connection,
                        `INSERT INTO dailyClosures (
                            branch, businessDate, closedBy, closedByName, snapshotJson
                         ) VALUES (?, ?, ?, ?, ?)`,
                        [branch, businessDate, closedBy, closedByName, serializedSnapshot]
                    );
                    const closure = await get(
                        connection,
                        `SELECT id, branch, businessDate, closedBy, closedByName, closedAt, snapshotJson
                         FROM dailyClosures WHERE id = ?`,
                        [insert.id]
                    );
                    await AuditLog.createOnConnection(connection, {
                        eventType: 'BUSINESS_DAY_CLOSED',
                        userId: closedBy,
                        branch,
                        reason: `Z-reading finalized for ${businessDate}`,
                        details: {
                            closureId: closure.id,
                            businessDate,
                            transactionCount: snapshot.transactionCount,
                            grossSales: snapshot.grossSales,
                            refundTotal: snapshot.refundTotal,
                            netSales: snapshot.netSales
                        }
                    });
                    await run(connection, 'COMMIT');
                    transactionFinished = true;
                    await close(connection);
                    return resolve({ ...snapshot, closed: true, alreadyClosed: false, closure });
                } catch (error) {
                    if (transactionStarted && !transactionFinished) {
                        try {
                            await run(connection, 'ROLLBACK');
                            transactionFinished = true;
                        } catch (rollbackError) {
                            console.error('Z-reading rollback failed:', rollbackError);
                            error.message = `${error.message}; rollback failed: ${rollbackError.message}`;
                        }
                    }
                    try {
                        await close(connection);
                    } catch (closeError) {
                        console.error('Z-reading connection cleanup failed:', closeError);
                        error.message = `${error.message}; cleanup failed: ${closeError.message}`;
                    }
                    reject(error);
                }
            });
        });
    }
}

module.exports = Reading;
