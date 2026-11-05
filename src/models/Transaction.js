const db = require('../database');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const AuditLog = require('./AuditLog');
const InventoryMovement = require('./InventoryMovement');
const Reading = require('./Reading');
const { normalizePaymentMethod } = require('../services/paymentMethod');
const { getBusinessDate } = require('../services/businessDate');

function buildScope(branch, userId) {
    const clauses = [];
    const values = [];
    if (branch) {
        clauses.push('branch = ?');
        values.push(branch);
    }
    if (userId) {
        clauses.push('userId = ?');
        values.push(userId);
    }
    return {
        sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
        values
    };
}

function allocateDiscountCents(items, discountCents) {
    const subtotalCents = items.reduce((sum, item) => sum + Math.round(Number(item.lineTotal) * 100), 0);
    if (discountCents < 0 || discountCents > subtotalCents) {
        throw new Error('Transaction discount is invalid; refund cannot be calculated safely');
    }

    const allocations = items.map(item => {
        const lineCents = Math.round(Number(item.lineTotal) * 100);
        const numerator = discountCents * lineCents;
        return {
            id: item.id,
            discountCents: Math.floor(numerator / subtotalCents),
            remainder: numerator % subtotalCents
        };
    });
    let remainingCents = discountCents - allocations.reduce((sum, item) => sum + item.discountCents, 0);
    const byLargestRemainder = [...allocations].sort((a, b) => b.remainder - a.remainder || a.id - b.id);
    for (let index = 0; index < remainingCents; index++) byLargestRemainder[index].discountCents++;
    return new Map(allocations.map(item => [item.id, item.discountCents]));
}

function amountForReturnedUnits(item, previouslyRefunded, quantity, lineNetCents) {
    const unitBaseCents = Math.floor(lineNetCents / item.quantity);
    const extraCentUnits = lineNetCents % item.quantity;
    const end = previouslyRefunded + quantity;
    const extraUnitsInRefund = Math.max(0, Math.min(end, extraCentUnits) - Math.min(previouslyRefunded, extraCentUnits));
    return unitBaseCents * quantity + extraUnitsInRefund;
}

// ========================================
// TRANSACTION MODEL
// ========================================

class Transaction {
    /**
     * Create new transaction with items
     * @param {Object} txnData
     * @returns {Promise<Object>}
     */
    static create(txnData) {
        return new Promise((resolve, reject) => {
            const {
                txnNo,
                userId,
                cashierName,
                customerName,
                items,
                discountAmount,
                discountReason,
                discountType,
                priceOverrides = [],
                expectedTotal,
                tenderedAmount,
                changeAmount,
                paymentMethod,
                branch,
                referenceNo,
                notes
            } = txnData;

            if (typeof txnNo !== 'string' || !txnNo.trim()) return reject(new Error('Transaction number is required'));
            if (!Number.isInteger(userId) || userId <= 0) return reject(new Error('Authenticated user is required'));
            if (typeof cashierName !== 'string' || !cashierName.trim()) return reject(new Error('Cashier name is required'));
            if (typeof branch !== 'string' || !branch.trim()) return reject(new Error('User branch is required'));
            if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
                return reject(new Error('Transaction must have at least one item'));
            }
            const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod);
            if (!normalizedPaymentMethod) return reject(new Error('Payment method must be CASH, CARD, BANK, or E-WALLET'));
            if (typeof discountAmount !== 'number' || !Number.isFinite(discountAmount) || discountAmount < 0) {
                return reject(new Error('Discount amount must be a valid non-negative number'));
            }
            const normalizedDiscountReason = typeof discountReason === 'string' ? discountReason.trim() : '';
            const normalizedDiscountType = typeof discountType === 'string' ? discountType.trim().toUpperCase() : '';
            if (discountAmount > 0 &&
                (normalizedDiscountReason.length < 5 || normalizedDiscountReason.length > 200 ||
                    !['SENIOR_PWD', 'PROMO', 'CUSTOM'].includes(normalizedDiscountType))) {
                return reject(new Error('A valid discount type and 5-200 character reason are required'));
            }
            if (!Number.isFinite(tenderedAmount) || !Number.isFinite(changeAmount) ||
                tenderedAmount < 0 || changeAmount < 0) {
                return reject(new Error('Cash tendered and change must be valid non-negative amounts'));
            }

            if (!Array.isArray(priceOverrides)) return reject(new Error('Price overrides must be a list'));
            const overridesByProductId = new Map();
            for (const override of priceOverrides) {
                const productId = override?.productId;
                const newUnitPrice = Number(override?.newUnitPrice);
                const reason = typeof override?.reason === 'string' ? override.reason.trim() : '';
                if (!Number.isSafeInteger(productId) || productId <= 0 ||
                    !Number.isFinite(newUnitPrice) || newUnitPrice <= 0 || newUnitPrice > 1000000 ||
                    reason.length < 5 || reason.length > 200 || overridesByProductId.has(productId)) {
                    return reject(new Error('Each price override needs a unique product, valid price, and 5-200 character reason'));
                }
                overridesByProductId.set(productId, { newUnitPrice: Math.round(newUnitPrice * 100) / 100, reason });
            }

            const quantities = new Map();
            for (const item of items) {
                if (!item || !Number.isSafeInteger(item.productId) || item.productId <= 0 ||
                    !Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
                    return reject(new Error('Each item must have a valid product ID and positive whole-number quantity'));
                }
                const totalQuantity = (quantities.get(item.productId) || 0) + item.quantity;
                if (!Number.isSafeInteger(totalQuantity)) {
                    return reject(new Error('Combined product quantity is too large'));
                }
                quantities.set(item.productId, totalQuantity);
            }

            const normalizedItems = Array.from(quantities, ([productId, quantity]) => ({ productId, quantity }))
                .sort((a, b) => a.productId - b.productId);
            for (const productId of overridesByProductId.keys()) {
                if (!quantities.has(productId)) {
                    return reject(new Error('A price override must belong to an item in this transaction'));
                }
            }
            const normalizedCustomerName = String(customerName || 'GUEST CUSTOMER').trim().slice(0, 120);
            const normalizedReferenceNo = String(referenceNo || '').trim().slice(0, 120);
            if (['CARD', 'BANK', 'E-WALLET'].includes(normalizedPaymentMethod) && !normalizedReferenceNo) {
                return reject(new Error('A payment reference number is required for card, bank, and e-wallet payments'));
            }
            const requestHash = crypto.createHash('sha256').update(JSON.stringify({
                userId,
                branch,
                customerName: normalizedCustomerName,
                items: normalizedItems,
                discountAmount: Math.round(discountAmount * 100),
                discountReason: normalizedDiscountReason,
                discountType: normalizedDiscountType,
                priceOverrides: Array.from(overridesByProductId, ([productId, override]) => ({ productId, ...override })),
                tenderedAmount: Math.round(tenderedAmount * 100),
                changeAmount: Math.round(changeAmount * 100),
                paymentMethod: normalizedPaymentMethod,
                referenceNo: normalizedReferenceNo
            })).digest('hex');
            let finished = false;

            const transactionDb = new sqlite3.Database(db.databasePath, (openError) => {
                if (openError) return reject(openError);
                transactionDb.configure('busyTimeout', 5000);
                transactionDb.run('PRAGMA foreign_keys = ON', (pragmaError) => {
                    if (pragmaError) {
                        return transactionDb.close(() => reject(pragmaError));
                    }
                    transactionDb.run('BEGIN IMMEDIATE TRANSACTION', beginError => {
                        if (beginError) return transactionDb.close(() => reject(beginError));
                        beginTransaction();
                    });
                });
            });

            function beginTransaction() {
                const rollback = (error) => {
                    if (finished) return;
                    finished = true;
                    transactionDb.run('ROLLBACK', (rollbackError) => {
                        transactionDb.close(closeError => {
                            if (rollbackError || closeError) {
                                const cleanupError = rollbackError || closeError;
                                console.error('Sale rollback/connection cleanup failed:', cleanupError);
                                error.message = `${error.message}; cleanup failed: ${cleanupError.message}`;
                            }
                            reject(error);
                        });
                    });
                };

                const commit = (result) => {
                    transactionDb.run('COMMIT', (commitError) => {
                        if (commitError) return rollback(commitError);
                        finished = true;
                        transactionDb.close(closeError => {
                            if (closeError) {
                                console.error('Sale committed but database connection close failed:', closeError);
                                return reject(closeError);
                            }
                            resolve(result);
                        });
                    });
                };

                transactionDb.get(
                    'SELECT id, userId, branch, requestHash FROM transactions WHERE txnNo = ?',
                    [txnNo],
                    (lookupError, existing) => {
                        if (lookupError) return rollback(lookupError);
                        if (existing) {
                            if (existing.userId === userId && existing.branch === branch && existing.requestHash === requestHash) {
                                return commit({
                                    id: existing.id,
                                    txnNo,
                                    idempotent: true
                                });
                            }
                            const conflict = new Error('Transaction number is already used by a different sale. Refresh the transaction number and try again.');
                            conflict.code = 'IDEMPOTENCY_CONFLICT';
                            return rollback(conflict);
                        }
                        Reading.assertBusinessDayOpen(transactionDb, branch)
                            .then(() => loadProducts(0, []))
                            .catch(rollback);
                    }
                );

                function loadProducts(index, products) {
                    if (index >= normalizedItems.length) {
                        return saveSale(products);
                    }

                    const item = normalizedItems[index];
                    transactionDb.get(
                        `SELECT id, code, name, price, stock
                         FROM products WHERE id = ? AND isActive = 1`,
                        [item.productId],
                        (productError, product) => {
                            if (productError) return rollback(productError);
                            if (!product) return rollback(new Error(`Product ID ${item.productId} is unavailable`));
                            if (product.stock < item.quantity) {
                                return rollback(new Error(`Insufficient stock for ${product.name}; available: ${product.stock}`));
                            }

                            const override = overridesByProductId.get(item.productId);
                            const originalUnitPriceCents = Math.round(Number(product.price) * 100);
                            const unitPriceCents = override
                                ? Math.round(override.newUnitPrice * 100)
                                : originalUnitPriceCents;
                            products.push({
                                ...item,
                                productCode: product.code,
                                productName: product.name,
                                previousStock: product.stock,
                                unitPrice: unitPriceCents / 100,
                                lineTotal: Math.round(unitPriceCents * item.quantity) / 100,
                                priceOverride: override ? {
                                    originalUnitPrice: originalUnitPriceCents / 100,
                                    newUnitPrice: unitPriceCents / 100,
                                    reason: override.reason
                                } : null
                            });
                            loadProducts(index + 1, products);
                        }
                    );
                }

                function saveSale(products) {
                    const subtotalCents = products.reduce((sum, item) => sum + Math.round(item.lineTotal * 100), 0);
                    const discountCents = Math.round(discountAmount * 100);
                    const maxDiscountCents = Math.floor(subtotalCents * 0.2 + 1e-8);
                    if (discountCents > maxDiscountCents) {
                        return rollback(new Error('Discount cannot exceed 20% of the product subtotal'));
                    }
                    const totalCents = subtotalCents - discountCents;
                    if (totalCents <= 0) return rollback(new Error('Total amount must be greater than zero'));
                    if (!Number.isFinite(expectedTotal) || Math.round(expectedTotal * 100) !== totalCents) {
                        return rollback(new Error('Product prices or discount changed. Refresh the cart and confirm the amount again.'));
                    }
                    const tenderedCents = Math.round(tenderedAmount * 100);
                    const changeCents = Math.round(changeAmount * 100);
                    if (normalizedPaymentMethod === 'CASH' &&
                        (tenderedCents < totalCents || changeCents !== tenderedCents - totalCents)) {
                        return rollback(new Error('Cash tendered must cover the total and the change amount must be exact'));
                    }
                    if (normalizedPaymentMethod !== 'CASH' &&
                        (tenderedCents !== totalCents || changeCents !== 0)) {
                        return rollback(new Error('Non-cash payment amount must match the total and cannot include change'));
                    }
                    const vatableSalesCents = Math.round(totalCents / 1.12);
                    const vatAmountCents = totalCents - vatableSalesCents;

                    updateStock(0, products, () => {
                        transactionDb.run(
                            `INSERT INTO transactions (
                                txnNo, userId, cashierName, customerName, branch, requestHash,
                                subtotal, discountAmount, vatableSales, vatAmount, totalAmount,
                                tenderedAmount, changeAmount,
                                paymentMethod, referenceNo, notes
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [
                                txnNo, userId, cashierName, normalizedCustomerName, branch, requestHash,
                                subtotalCents / 100, discountCents / 100, vatableSalesCents / 100,
                                vatAmountCents / 100, totalCents / 100, tenderedCents / 100,
                                changeCents / 100, normalizedPaymentMethod,
                                normalizedReferenceNo, String(notes || '').slice(0, 500)
                            ],
                            function(insertError) {
                                if (insertError) return rollback(insertError);
                                const transactionId = this.lastID;
                                const insertSaleItems = () => insertItems(transactionId, products, 0, () => {
                                    AuditLog.createOnConnection(transactionDb, {
                                        eventType: 'TRANSACTION_COMPLETED',
                                        userId,
                                        branch,
                                        transactionId,
                                        reason: `Completed sale ${txnNo}`,
                                        details: {
                                            transactionNumber: txnNo,
                                            customerName: normalizedCustomerName,
                                            paymentMethod: normalizedPaymentMethod,
                                            totalAmount: totalCents / 100,
                                            itemCount: products.length
                                        }
                                    }).then(() => awardLoyaltyPoints(() => commit({
                                        id: transactionId,
                                        txnNo,
                                        subtotal: subtotalCents / 100,
                                        discountAmount: discountCents / 100,
                                        vatableSales: vatableSalesCents / 100,
                                        vatAmount: vatAmountCents / 100,
                                        totalAmount: totalCents / 100,
                                        tenderedAmount: tenderedCents / 100,
                                        changeAmount: changeCents / 100,
                                        paymentMethod: normalizedPaymentMethod,
                                        customerName: normalizedCustomerName,
                                        notes: String(notes || '').slice(0, 500),
                                        items: products,
                                        itemCount: products.length,
                                        timestamp: new Date().toISOString()
                                    }))).catch(rollback);
                                });
                                // One point is earned for every complete PHP 100 paid.  Guest sales do not
                                // create profiles implicitly, preventing accidental duplicate customers.
                                function awardLoyaltyPoints(done) {
                                    if (normalizedCustomerName === 'GUEST CUSTOMER') return done();
                                    const points = Math.floor(totalCents / 10000);
                                    if (points === 0) return done();
                                    transactionDb.run(
                                        `UPDATE customers SET loyaltyPoints = loyaltyPoints + ?, updatedAt = CURRENT_TIMESTAMP
                                         WHERE name = ? AND isActive = 1`,
                                        [points, normalizedCustomerName],
                                        loyaltyError => loyaltyError ? rollback(loyaltyError) : done()
                                    );
                                }
                                const recordPriceOverrideAudits = index => {
                                    const item = products[index];
                                    if (!item) return insertSaleItems();
                                    if (!item.priceOverride) return recordPriceOverrideAudits(index + 1);
                                    AuditLog.createOnConnection(transactionDb, {
                                        eventType: 'PRICE_OVERRIDE_APPLIED',
                                        userId,
                                        branch,
                                        transactionId,
                                        productId: item.productId,
                                        reason: item.priceOverride.reason,
                                        details: {
                                            productCode: item.productCode,
                                            productName: item.productName,
                                            originalUnitPrice: item.priceOverride.originalUnitPrice,
                                            newUnitPrice: item.priceOverride.newUnitPrice,
                                            quantity: item.quantity,
                                            amountDifference: Number(((item.priceOverride.newUnitPrice - item.priceOverride.originalUnitPrice) * item.quantity).toFixed(2))
                                        }
                                    }).then(() => recordPriceOverrideAudits(index + 1)).catch(rollback);
                                };
                                const recordAuditsThenItems = () => recordPriceOverrideAudits(0);
                                if (discountCents > 0) {
                                    AuditLog.createOnConnection(transactionDb, {
                                        eventType: 'DISCOUNT_APPLIED',
                                        userId,
                                        branch,
                                        transactionId,
                                        reason: normalizedDiscountReason,
                                        details: {
                                            discountType: normalizedDiscountType,
                                            discountAmount: discountCents / 100,
                                            subtotal: subtotalCents / 100,
                                            totalAmount: totalCents / 100
                                        }
                                    }).then(recordAuditsThenItems).catch(rollback);
                                } else {
                                    recordAuditsThenItems();
                                }
                            }
                        );
                    });
                }

                function updateStock(index, products, callback) {
                    if (index >= products.length) return callback();
                    const item = products[index];
                    transactionDb.run(
                        `UPDATE products SET stock = stock - ?, updatedAt = CURRENT_TIMESTAMP
                         WHERE id = ? AND isActive = 1 AND stock >= ?`,
                        [item.quantity, item.productId, item.quantity],
                        function(stockError) {
                            if (stockError) return rollback(stockError);
                            if (this.changes !== 1) {
                                return rollback(new Error(`Insufficient stock or inactive product for ID ${item.productId}`));
                            }
                            InventoryMovement.createOnConnection(transactionDb, {
                                productId: item.productId,
                                userId,
                                branch,
                                movementType: 'SALE',
                                quantityDelta: -item.quantity,
                                previousStock: item.previousStock,
                                newStock: item.previousStock - item.quantity,
                                reason: `Sale ${txnNo}`,
                                reference: txnNo
                            }).then(() => updateStock(index + 1, products, callback)).catch(rollback);
                        }
                    );
                }

                function insertItems(transactionId, products, index, callback) {
                    if (index >= products.length) return callback();
                    const item = products[index];
                    transactionDb.run(
                        `INSERT INTO transactionItems (
                            transactionId, productId, productCode, productName,
                            unitPrice, quantity, lineTotal
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [
                            transactionId, item.productId, item.productCode, item.productName,
                            item.unitPrice, item.quantity, item.lineTotal
                        ],
                        (insertError) => {
                            if (insertError) return rollback(insertError);
                            insertItems(transactionId, products, index + 1, callback);
                        }
                    );
                }
            }
        });
    }

    static getRefundPreview(txnNo, branch) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT id, txnNo, customerName, subtotal, discountAmount, totalAmount,
                        paymentMethod, createdAt, voidedAt
                 FROM transactions WHERE txnNo = ? AND branch = ?`,
                [txnNo, branch],
                (transactionError, transaction) => {
                    if (transactionError) return reject(transactionError);
                    if (!transaction) return resolve(null);

                    db.all(
                        `SELECT transactionItems.id, transactionItems.productId,
                                transactionItems.productCode, transactionItems.productName,
                                transactionItems.unitPrice, transactionItems.quantity,
                                transactionItems.lineTotal,
                                COALESCE(SUM(refundItems.quantity), 0) AS refundedQuantity
                         FROM transactionItems
                         LEFT JOIN refundItems ON refundItems.transactionItemId = transactionItems.id
                         LEFT JOIN refunds ON refunds.id = refundItems.refundId
                         WHERE transactionItems.transactionId = ?
                         GROUP BY transactionItems.id
                         ORDER BY transactionItems.id`,
                        [transaction.id],
                        (itemsError, items) => {
                            if (itemsError) return reject(itemsError);
                            db.get(
                                'SELECT COALESCE(SUM(refundAmount), 0) AS refundedAmount FROM refunds WHERE transactionId = ?',
                                [transaction.id],
                                (refundError, refundSummary) => {
                                    if (refundError) return reject(refundError);
                                    try {
                                        const discountCents = Math.round(Number(transaction.discountAmount) * 100);
                                        const allocations = allocateDiscountCents(items, discountCents);
                                        const refundableItems = items.map(item => {
                                            const lineCents = Math.round(Number(item.lineTotal) * 100);
                                            const lineNetCents = lineCents - allocations.get(item.id);
                                            const refundableQuantity = item.quantity - item.refundedQuantity;
                                            const refundableCents = amountForReturnedUnits(
                                                item,
                                                item.refundedQuantity,
                                                refundableQuantity,
                                                lineNetCents
                                            );
                                            return {
                                                ...item,
                                                refundedQuantity: Number(item.refundedQuantity),
                                                refundableQuantity,
                                                refundableAmount: refundableCents / 100
                                            };
                                        });
                                        const refundedAmount = Number(refundSummary.refundedAmount || 0);
                                        resolve({
                                            ...transaction,
                                            refundedAmount,
                                            refundableAmount: Math.max(0, Number(transaction.totalAmount) - refundedAmount),
                                            items: refundableItems
                                        });
                                    } catch (error) {
                                        reject(error);
                                    }
                                }
                            );
                        }
                    );
                }
            );
        });
    }

    static getVoidPreview(txnNo, branch) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT id, txnNo, customerName, totalAmount, paymentMethod, referenceNo,
                        createdAt, voidedAt, voidReason
                 FROM transactions WHERE txnNo = ? AND branch = ?`,
                [txnNo, branch],
                (transactionError, transaction) => {
                    if (transactionError) return reject(transactionError);
                    if (!transaction) return resolve(null);
                    db.get(
                        'SELECT COUNT(*) AS refundCount FROM refunds WHERE transactionId = ?',
                        [transaction.id],
                        (refundError, refundSummary) => {
                            if (refundError) return reject(refundError);
                            const refundCount = Number(refundSummary?.refundCount || 0);
                            resolve({
                                ...transaction,
                                refundCount,
                                canVoid: !transaction.voidedAt && refundCount === 0
                            });
                        }
                    );
                }
            );
        });
    }

    static refund({ transactionId, requestId, userId, cashierName, branch, reason, items }) {
        const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
        if (normalizedReason.length < 5 || normalizedReason.length > 200) {
            return Promise.reject(new Error('Refund reason must be 5-200 characters'));
        }
        if (typeof requestId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
            return Promise.reject(new Error('A valid refund request ID is required'));
        }
        if (!Number.isSafeInteger(transactionId) || transactionId <= 0 ||
            !Number.isInteger(userId) || userId <= 0 ||
            typeof cashierName !== 'string' || !cashierName.trim() ||
            typeof branch !== 'string' || !branch.trim()) {
            return Promise.reject(new Error('A valid transaction, cashier, and branch are required'));
        }
        if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
            return Promise.reject(new Error('Select at least one item to refund'));
        }

        const normalizedItems = new Map();
        for (const item of items) {
            if (!item || !Number.isSafeInteger(item.transactionItemId) || item.transactionItemId <= 0 ||
                !Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
                return Promise.reject(new Error('Each refunded item needs a valid sale item ID and positive whole-number quantity'));
            }
            const quantity = (normalizedItems.get(item.transactionItemId) || 0) + item.quantity;
            if (!Number.isSafeInteger(quantity)) {
                return Promise.reject(new Error('Combined refund quantity is too large'));
            }
            normalizedItems.set(item.transactionItemId, quantity);
        }
        const selectedItems = Array.from(normalizedItems, ([transactionItemId, quantity]) => ({
            transactionItemId,
            quantity
        })).sort((a, b) => a.transactionItemId - b.transactionItemId);
        const requestHash = crypto.createHash('sha256').update(JSON.stringify({
            transactionId,
            userId,
            branch,
            reason: normalizedReason,
            items: selectedItems
        })).digest('hex');

        return new Promise((resolve, reject) => {
            const transactionDb = new sqlite3.Database(db.databasePath, async openError => {
                if (openError) return reject(openError);
                transactionDb.configure('busyTimeout', 5000);
                const run = (sql, params = []) => new Promise((runResolve, runReject) => {
                    transactionDb.run(sql, params, function(error) {
                        if (error) return runReject(error);
                        runResolve({ id: this.lastID, changes: this.changes });
                    });
                });
                const get = (sql, params = []) => new Promise((getResolve, getReject) => {
                    transactionDb.get(sql, params, (error, row) => error ? getReject(error) : getResolve(row));
                });
                const all = (sql, params = []) => new Promise((allResolve, allReject) => {
                    transactionDb.all(sql, params, (error, rows) => error ? allReject(error) : allResolve(rows || []));
                });
                const close = () => new Promise((closeResolve, closeReject) => {
                    transactionDb.close(error => error ? closeReject(error) : closeResolve());
                });

                let transactionStarted = false;
                let transactionFinished = false;
                try {
                    await run('PRAGMA foreign_keys = ON');
                    await run('BEGIN IMMEDIATE TRANSACTION');
                    transactionStarted = true;

                    const existing = await get(
                        'SELECT id, transactionId, userId, branch, requestHash, refundAmount FROM refunds WHERE requestId = ?',
                        [requestId]
                    );
                    if (existing) {
                        if (existing.transactionId !== transactionId || existing.userId !== userId ||
                            existing.branch !== branch || existing.requestHash !== requestHash) {
                            const conflict = new Error('Refund request ID was already used for a different refund');
                            conflict.code = 'IDEMPOTENCY_CONFLICT';
                            throw conflict;
                        }
                        await run('COMMIT');
                        transactionFinished = true;
                        await close();
                        return resolve({
                            id: existing.id,
                            transactionId,
                            refundAmount: Number(existing.refundAmount),
                            idempotent: true
                        });
                    }

                    await Reading.assertBusinessDayOpen(transactionDb, branch);

                    const sale = await get(
                        'SELECT id, txnNo, branch, subtotal, discountAmount, totalAmount, voidedAt FROM transactions WHERE id = ? AND branch = ?',
                        [transactionId, branch]
                    );
                    if (!sale) throw new Error('Transaction not found in this branch');
                    if (sale.voidedAt) throw new Error('A voided transaction cannot be refunded');
                    const saleItems = await all(
                        `SELECT transactionItems.id, transactionItems.productId,
                                transactionItems.productName, transactionItems.quantity,
                                transactionItems.lineTotal,
                                COALESCE(SUM(refundItems.quantity), 0) AS refundedQuantity
                         FROM transactionItems
                         LEFT JOIN refundItems ON refundItems.transactionItemId = transactionItems.id
                         LEFT JOIN refunds ON refunds.id = refundItems.refundId
                         WHERE transactionItems.transactionId = ?
                         GROUP BY transactionItems.id
                         ORDER BY transactionItems.id`,
                        [transactionId]
                    );
                    const itemById = new Map(saleItems.map(item => [item.id, item]));
                    const discountAllocations = allocateDiscountCents(
                        saleItems,
                        Math.round(Number(sale.discountAmount) * 100)
                    );
                    const normalizedRefundItems = [];
                    let refundCents = 0;
                    for (const selected of selectedItems) {
                        const saleItem = itemById.get(selected.transactionItemId);
                        if (!saleItem) throw new Error('A selected item does not belong to this transaction');
                        const refundedQuantity = Number(saleItem.refundedQuantity);
                        if (selected.quantity > saleItem.quantity - refundedQuantity) {
                            throw new Error(`Refund quantity exceeds the remaining sold quantity for ${saleItem.productName}`);
                        }
                        const lineCents = Math.round(Number(saleItem.lineTotal) * 100);
                        const lineNetCents = lineCents - discountAllocations.get(saleItem.id);
                        const itemRefundCents = amountForReturnedUnits(
                            saleItem,
                            refundedQuantity,
                            selected.quantity,
                            lineNetCents
                        );
                        if (itemRefundCents <= 0) throw new Error('Selected items have no refundable value');
                        refundCents += itemRefundCents;
                        normalizedRefundItems.push({
                            ...selected,
                            productId: saleItem.productId,
                            refundAmount: itemRefundCents / 100
                        });
                    }
                    if (refundCents <= 0 || refundCents > Math.round(Number(sale.totalAmount) * 100)) {
                        throw new Error('Calculated refund amount is invalid');
                    }

                    const insertedRefund = await run(
                        `INSERT INTO refunds (
                            requestId, requestHash, transactionId, userId, branch, refundAmount, reason
                         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [requestId, requestHash, transactionId, userId, branch, refundCents / 100, normalizedReason]
                    );
                    for (const item of normalizedRefundItems) {
                        await run(
                            `INSERT INTO refundItems (refundId, transactionItemId, quantity, refundAmount)
                             VALUES (?, ?, ?, ?)`,
                            [insertedRefund.id, item.transactionItemId, item.quantity, item.refundAmount]
                        );
                        const product = await get('SELECT stock FROM products WHERE id = ?', [item.productId]);
                        if (!product) throw new Error('Refund item product no longer exists');
                        const previousStock = Number(product.stock);
                        const newStock = previousStock + item.quantity;
                        if (!Number.isSafeInteger(newStock)) throw new Error('Refund stock exceeds the supported range');
                        const updated = await run(
                            `UPDATE products SET stock = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
                            [newStock, item.productId]
                        );
                        if (updated.changes !== 1) throw new Error('Refund item stock could not be restored');
                        await InventoryMovement.createOnConnection(transactionDb, {
                            productId: item.productId,
                            userId,
                            branch,
                            movementType: 'REFUND',
                            quantityDelta: item.quantity,
                            previousStock,
                            newStock,
                            reason: normalizedReason,
                            reference: sale.txnNo
                        });
                    }
                    await AuditLog.createOnConnection(transactionDb, {
                        eventType: 'TRANSACTION_REFUNDED',
                        userId,
                        branch,
                        transactionId,
                        reason: normalizedReason,
                        details: {
                            refundId: insertedRefund.id,
                            requestId,
                            transactionNumber: sale.txnNo,
                            refundAmount: refundCents / 100,
                            items: normalizedRefundItems.map(item => ({
                                transactionItemId: item.transactionItemId,
                                quantity: item.quantity,
                                refundAmount: item.refundAmount
                            }))
                        }
                    });
                    await run('COMMIT');
                    transactionFinished = true;
                    await close();
                    resolve({
                        id: insertedRefund.id,
                        transactionId,
                        transactionNumber: sale.txnNo,
                        refundAmount: refundCents / 100,
                        idempotent: false
                    });
                } catch (error) {
                    if (transactionStarted && !transactionFinished) {
                        try {
                            await run('ROLLBACK');
                            transactionFinished = true;
                        } catch (rollbackError) {
                            console.error('Refund rollback failed:', rollbackError);
                            error.message = `${error.message}; rollback failed: ${rollbackError.message}`;
                        }
                    }
                    try {
                        await close();
                    } catch (closeError) {
                        console.error('Refund database connection cleanup failed:', closeError);
                        error.message = `${error.message}; connection cleanup failed: ${closeError.message}`;
                    }
                    reject(error);
                }
            });
        });
    }

    static voidSale({ transactionId, requestId, userId, cashierName, branch, reason }) {
        const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
        if (normalizedReason.length < 5 || normalizedReason.length > 200) {
            return Promise.reject(new Error('Void reason must be 5-200 characters'));
        }
        if (typeof requestId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
            return Promise.reject(new Error('A valid void request ID is required'));
        }
        if (!Number.isSafeInteger(transactionId) || transactionId <= 0 ||
            !Number.isInteger(userId) || userId <= 0 ||
            typeof cashierName !== 'string' || !cashierName.trim() ||
            typeof branch !== 'string' || !branch.trim()) {
            return Promise.reject(new Error('A valid transaction, cashier, and branch are required'));
        }

        const requestHash = crypto.createHash('sha256').update(JSON.stringify({
            transactionId,
            userId,
            branch,
            reason: normalizedReason
        })).digest('hex');

        return new Promise((resolve, reject) => {
            const transactionDb = new sqlite3.Database(db.databasePath, async openError => {
                if (openError) return reject(openError);
                transactionDb.configure('busyTimeout', 5000);
                const run = (sql, params = []) => new Promise((runResolve, runReject) => {
                    transactionDb.run(sql, params, function(error) {
                        if (error) return runReject(error);
                        runResolve({ id: this.lastID, changes: this.changes });
                    });
                });
                const get = (sql, params = []) => new Promise((getResolve, getReject) => {
                    transactionDb.get(sql, params, (error, row) => error ? getReject(error) : getResolve(row));
                });
                const all = (sql, params = []) => new Promise((allResolve, allReject) => {
                    transactionDb.all(sql, params, (error, rows) => error ? allReject(error) : allResolve(rows || []));
                });
                const close = () => new Promise((closeResolve, closeReject) => {
                    transactionDb.close(error => error ? closeReject(error) : closeResolve());
                });

                let transactionStarted = false;
                let transactionFinished = false;
                try {
                    await run('PRAGMA foreign_keys = ON');
                    await run('BEGIN IMMEDIATE TRANSACTION');
                    transactionStarted = true;

                    const sale = await get(
                        `SELECT id, txnNo, voidedAt, voidedBy, voidRequestId, voidRequestHash
                         FROM transactions WHERE id = ? AND branch = ?`,
                        [transactionId, branch]
                    );
                    if (!sale) throw new Error('Transaction not found in this branch');
                    if (sale.voidedAt) {
                        if (sale.voidRequestId === requestId &&
                            sale.voidRequestHash === requestHash &&
                            sale.voidedBy === userId) {
                            await run('COMMIT');
                            transactionFinished = true;
                            await close();
                            return resolve({
                                transactionId,
                                transactionNumber: sale.txnNo,
                                idempotent: true
                            });
                        }
                        throw new Error('Transaction has already been voided');
                    }

                    await Reading.assertBusinessDayOpen(transactionDb, branch);

                    const refund = await get(
                        'SELECT COUNT(*) AS count FROM refunds WHERE transactionId = ?',
                        [transactionId]
                    );
                    if (Number(refund.count) > 0) {
                        throw new Error('A transaction with a recorded refund cannot be voided');
                    }
                    const items = await all(
                        `SELECT productId, productName, quantity
                         FROM transactionItems WHERE transactionId = ? ORDER BY id`,
                        [transactionId]
                    );
                    if (items.length === 0) throw new Error('Transaction has no sale items to restore');

                    const voidUpdate = await run(
                        `UPDATE transactions
                         SET voidedAt = CURRENT_TIMESTAMP, voidReason = ?, voidedBy = ?,
                             voidRequestId = ?, voidRequestHash = ?, updatedAt = CURRENT_TIMESTAMP
                         WHERE id = ? AND branch = ? AND voidedAt IS NULL`,
                        [normalizedReason, userId, requestId, requestHash, transactionId, branch]
                    );
                    if (voidUpdate.changes !== 1) throw new Error('Transaction is no longer eligible to void');
                    for (const item of items) {
                        const product = await get('SELECT stock FROM products WHERE id = ?', [item.productId]);
                        if (!product) throw new Error('Voided sale product no longer exists');
                        const previousStock = Number(product.stock);
                        const newStock = previousStock + item.quantity;
                        if (!Number.isSafeInteger(newStock)) throw new Error('Void stock exceeds the supported range');
                        const updated = await run(
                            'UPDATE products SET stock = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
                            [newStock, item.productId]
                        );
                        if (updated.changes !== 1) throw new Error('Voided sale stock could not be restored');
                        await InventoryMovement.createOnConnection(transactionDb, {
                            productId: item.productId,
                            userId,
                            branch,
                            movementType: 'VOID',
                            quantityDelta: item.quantity,
                            previousStock,
                            newStock,
                            reason: normalizedReason,
                            reference: sale.txnNo
                        });
                    }
                    await AuditLog.createOnConnection(transactionDb, {
                        eventType: 'TRANSACTION_VOIDED',
                        userId,
                        branch,
                        transactionId,
                        reason: normalizedReason,
                        details: {
                            requestId,
                            transactionNumber: sale.txnNo,
                            items: items.map(item => ({
                                productId: item.productId,
                                productName: item.productName,
                                quantity: item.quantity
                            }))
                        }
                    });
                    await run('COMMIT');
                    transactionFinished = true;
                    await close();
                    resolve({
                        transactionId,
                        transactionNumber: sale.txnNo,
                        idempotent: false
                    });
                } catch (error) {
                    if (transactionStarted && !transactionFinished) {
                        try {
                            await run('ROLLBACK');
                            transactionFinished = true;
                        } catch (rollbackError) {
                            console.error('Void rollback failed:', rollbackError);
                            error.message = `${error.message}; rollback failed: ${rollbackError.message}`;
                        }
                    }
                    try {
                        await close();
                    } catch (closeError) {
                        console.error('Void database connection cleanup failed:', closeError);
                        error.message = `${error.message}; connection cleanup failed: ${closeError.message}`;
                    }
                    reject(error);
                }
            });
        });
    }


    /**
     * Get transaction by ID with all items
     * @param {number} id
     * @returns {Promise<Object|null>}
     */
    static getById(id, branch, userId) {
        return new Promise((resolve, reject) => {
            const scope = buildScope(branch, userId);
            db.get(
                `SELECT transactions.id, transactions.txnNo, transactions.userId,
                        transactions.cashierName, transactions.customerName,
                        transactions.subtotal, transactions.discountAmount,
                        transactions.vatableSales, transactions.vatAmount,
                        transactions.totalAmount, transactions.tenderedAmount,
                        transactions.changeAmount, transactions.paymentMethod,
                        transactions.referenceNo, transactions.notes, transactions.createdAt,
                        transactions.voidedAt, transactions.voidReason, transactions.voidedBy,
                        legacy.originalTxnNo
                 FROM transactions
                 LEFT JOIN legacyTransactionImports AS legacy
                    ON legacy.targetTransactionId = transactions.id
                 WHERE transactions.id = ?${scope.sql}`,
                [id, ...scope.values],
                (err, transaction) => {
                    if (err) return reject(err);
                    if (!transaction) return resolve(null);

                    // Get items
                    db.all(
                        `SELECT id, productId, productCode, productName,
                                unitPrice, quantity, lineTotal, createdAt
                         FROM transactionItems WHERE transactionId = ?`,
                        [id],
                        (err, items) => {
                            if (err) return reject(err);
                            transaction.items = items || [];
                            resolve(transaction);
                        }
                    );
                }
            );
        });
    }

    /**
     * Get transaction by transaction number
     * @param {string} txnNo
     * @returns {Promise<Object|null>}
     */
    static getByTxnNo(txnNo, branch, userId) {
        return new Promise((resolve, reject) => {
            const scope = buildScope(branch, userId);
            db.get(
                `SELECT id FROM transactions WHERE txnNo = ?${scope.sql}`,
                [txnNo, ...scope.values],
                (err, row) => {
                    if (err) return reject(err);
                    if (!row) return resolve(null);
                    this.getById(row.id, branch, userId).then(resolve).catch(reject);
                }
            );
        });
    }

    static getByOriginalTxnNo(txnNo, branch, userId) {
        return new Promise((resolve, reject) => {
            const scope = buildScope(branch, userId);
            db.get(
                `SELECT transactions.id
                 FROM transactions
                 INNER JOIN legacyTransactionImports AS legacy
                    ON legacy.targetTransactionId = transactions.id
                 WHERE legacy.originalTxnNo = ?${scope.sql}
                 LIMIT 1`,
                [txnNo, ...scope.values],
                (err, row) => {
                    if (err) return reject(err);
                    if (!row) return resolve(null);
                    this.getById(row.id, branch, userId).then(resolve).catch(reject);
                }
            );
        });
    }

    /**
     * Generate the next sequential transaction number for the current branch/year.
     * @param {string} branchCode
     * @param {number} year
     * @returns {Promise<string>}
     */
    static getNextTxnNo(branchCode = '01', year = Number(getBusinessDate().slice(0, 4))) {
        return new Promise((resolve, reject) => {
            const prefix = `${branchCode}-${year}-`;
            db.get(
                `SELECT MAX(CAST(substr(txnNo, length(?) + 1) AS INTEGER)) AS maxSequence
                 FROM transactions
                 WHERE txnNo GLOB ?`,
                [prefix, `${prefix}[0-9][0-9][0-9][0-9][0-9]`],
                (err, row) => {
                    if (err) return reject(err);
                    const maxSequence = Number(row?.maxSequence || 0);
                    if (maxSequence >= 99999) {
                        return reject(new Error(`Transaction number sequence is exhausted for ${branchCode}-${year}`));
                    }
                    const nextSequence = maxSequence + 1;
                    return resolve(`${prefix}${String(nextSequence).padStart(5, '0')}`);
                }
            );
        });
    }

    /**
     * Get all transactions with pagination
     * @param {number} limit
     * @param {number} offset
     * @returns {Promise<Array>}
     */
    static getAll(limit = 50, offset = 0, branch, userId) {
        return new Promise((resolve, reject) => {
            const scope = buildScope(branch, userId);
            db.all(
                `SELECT transactions.id, transactions.txnNo, transactions.userId,
                       transactions.cashierName, transactions.customerName,
                       transactions.subtotal, transactions.discountAmount,
                       transactions.totalAmount, transactions.paymentMethod,
                       transactions.createdAt, transactions.voidedAt, transactions.voidReason,
                       legacy.originalTxnNo
                 FROM transactions
                 LEFT JOIN legacyTransactionImports AS legacy
                    ON legacy.targetTransactionId = transactions.id
                 WHERE 1 = 1${scope.sql}
                 ORDER BY transactions.createdAt DESC, transactions.id DESC LIMIT ? OFFSET ?`,
                [...scope.values, limit, offset],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    /**
     * Get transactions by user (cashier)
     * @param {number} userId
     * @param {number} limit
     * @param {number} offset
     * @returns {Promise<Array>}
     */
    static getByUserId(userId, limit = 50, offset = 0, branch) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT id, txnNo, userId, cashierName, customerName,
                       subtotal, discountAmount, totalAmount, paymentMethod, createdAt,
                       voidedAt, voidReason
                 FROM transactions WHERE userId = ?${branch ? ' AND branch = ?' : ''}
                 ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
                branch ? [userId, branch, limit, offset] : [userId, limit, offset],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    /**
     * Get transactions by date range
     * @param {string} startDate YYYY-MM-DD
     * @param {string} endDate YYYY-MM-DD
     * @returns {Promise<Array>}
     */
    static getByDateRange(startDate, endDate, branch, userId) {
        return new Promise((resolve, reject) => {
            const scope = buildScope(branch, userId);
            db.all(
                `SELECT id, txnNo, userId, cashierName, customerName,
                       subtotal, discountAmount, totalAmount, paymentMethod, createdAt,
                       voidedAt, voidReason
                FROM transactions 
                WHERE voidedAt IS NULL AND date(createdAt, '+8 hours') BETWEEN ? AND ?${scope.sql}
                 ORDER BY createdAt DESC`,
                [startDate, endDate, ...scope.values],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    /**
     * Get transactions by payment method
     * @param {string} paymentMethod
     * @param {number} limit
     * @returns {Promise<Array>}
     */
    static getByPaymentMethod(paymentMethod, limit = 50) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT id, txnNo, userId, cashierName, customerName,
                       subtotal, discountAmount, totalAmount, paymentMethod, createdAt,
                       voidedAt, voidReason
                FROM transactions 
                WHERE voidedAt IS NULL AND paymentMethod = ?
                 ORDER BY createdAt DESC LIMIT ?`,
                [paymentMethod, limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    /**
     * Get sales summary for date range
     * @param {string} startDate
     * @param {string} endDate
     * @returns {Promise<Object>}
     */
    static getSalesSummary(startDate, endDate, branch, userId) {
        return new Promise((resolve, reject) => {
            const scope = buildScope(branch, userId);
            db.get(
                `SELECT 
                    COUNT(*) as transactionCount,
                    SUM(totalAmount - COALESCE((
                        SELECT SUM(refundAmount) FROM refunds WHERE refunds.transactionId = transactions.id
                    ), 0)) as totalSales,
                    SUM(vatAmount - CASE WHEN totalAmount > 0 THEN
                        vatAmount * COALESCE((
                            SELECT SUM(refundAmount) FROM refunds WHERE refunds.transactionId = transactions.id
                        ), 0) / totalAmount ELSE 0 END) as totalVAT,
                    SUM(discountAmount) as totalDiscount,
                    AVG(totalAmount - COALESCE((
                        SELECT SUM(refundAmount) FROM refunds WHERE refunds.transactionId = transactions.id
                    ), 0)) as avgTransactionAmount,
                    MIN(totalAmount - COALESCE((
                        SELECT SUM(refundAmount) FROM refunds WHERE refunds.transactionId = transactions.id
                    ), 0)) as minAmount,
                    MAX(totalAmount - COALESCE((
                        SELECT SUM(refundAmount) FROM refunds WHERE refunds.transactionId = transactions.id
                    ), 0)) as maxAmount
                 FROM transactions 
                 WHERE voidedAt IS NULL AND date(createdAt, '+8 hours') BETWEEN ? AND ?${scope.sql}`,
                [startDate, endDate, ...scope.values],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row || {});
                }
            );
        });
    }

    /**
     * Get sales summary by payment method
     * @param {string} startDate
     * @param {string} endDate
     * @returns {Promise<Array>}
     */
    static getSalesByPaymentMethod(startDate, endDate, branch, userId) {
        return new Promise((resolve, reject) => {
            const scope = buildScope(branch, userId);
            db.all(
                `SELECT 
                    paymentMethod,
                    COUNT(*) as count,
                    SUM(totalAmount - COALESCE((
                        SELECT SUM(refundAmount) FROM refunds WHERE refunds.transactionId = transactions.id
                    ), 0)) as total
                 FROM transactions 
                 WHERE voidedAt IS NULL AND date(createdAt, '+8 hours') BETWEEN ? AND ?${scope.sql}
                 GROUP BY paymentMethod
                 ORDER BY total DESC`,
                [startDate, endDate, ...scope.values],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    /**
     * Get top products sold
     * @param {number} limit
     * @returns {Promise<Array>}
     */
    static getTopProducts(limit = 10, branch, userId) {
        return new Promise((resolve, reject) => {
            const scope = buildScope(branch, userId);
            db.all(
                `SELECT 
                    productCode,
                    productName,
                    SUM(transactionItems.quantity - COALESCE(refundedItems.refundedQuantity, 0)) as totalQty,
                    SUM(transactionItems.lineTotal *
                        (transactionItems.quantity - COALESCE(refundedItems.refundedQuantity, 0)) /
                        transactionItems.quantity) as totalSales,
                    AVG(unitPrice) as avgPrice
                 FROM transactionItems
                 INNER JOIN transactions ON transactions.id = transactionItems.transactionId
                 LEFT JOIN (
                    SELECT transactionItemId,
                           SUM(quantity) AS refundedQuantity
                    FROM refundItems
                    GROUP BY transactionItemId
                 ) AS refundedItems ON refundedItems.transactionItemId = transactionItems.id
                 WHERE transactions.voidedAt IS NULL${scope.sql}
                 GROUP BY productCode
                 HAVING SUM(transactionItems.quantity - COALESCE(refundedItems.refundedQuantity, 0)) > 0
                 ORDER BY totalQty DESC
                 LIMIT ?`,
                [...scope.values, limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    /**
     * Count total transactions
     * @returns {Promise<number>}
     */
    static count(branch, userId) {
        return new Promise((resolve, reject) => {
            const scope = buildScope(branch, userId);
            db.get(
                `SELECT COUNT(*) as count FROM transactions WHERE 1 = 1${scope.sql}`,
                scope.values,
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row?.count || 0);
                }
            );
        });
    }
}

module.exports = Transaction;
