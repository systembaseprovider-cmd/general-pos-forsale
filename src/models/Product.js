const db = require('../database');
const sqlite3 = require('sqlite3').verbose();
const AuditLog = require('./AuditLog');
const InventoryMovement = require('./InventoryMovement');

// ========================================
// PRODUCT MODEL
// ========================================

class Product {
    /**
     * Get all active products
     * @returns {Promise<Array>}
     */
    static getAll() {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT id, code, sku, name, uom, price, stock, reorderLevel,
                        category, description, isActive, createdAt
                 FROM products WHERE isActive = 1 ORDER BY name ASC`,
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    /**
     * Get product by ID
     * @param {number} id
     * @returns {Promise<Object|null>}
     */
    static getById(id) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT id, code, sku, name, uom, price, stock, reorderLevel,
                        category, description, isActive
                 FROM products WHERE id = ? AND isActive = 1`,
                [id],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                }
            );
        });
    }

    /**
     * Get product by code (barcode)
     * @param {string} code
     * @returns {Promise<Object|null>}
     */
    static getByCode(code) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT id, code, sku, name, uom, price, stock, reorderLevel,
                        category, description, isActive
                 FROM products WHERE code = ? AND isActive = 1`,
                [code],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                }
            );
        });
    }

    /**
     * Get products by category
     * @param {string} category
     * @returns {Promise<Array>}
     */
    static getByCategory(category) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT id, code, sku, name, uom, price, stock, reorderLevel,
                        category, description, isActive
                 FROM products WHERE category = ? AND isActive = 1 ORDER BY name ASC`,
                [category],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    /**
     * Search products by name
     * @param {string} searchTerm
     * @returns {Promise<Array>}
     */
    static search(searchTerm) {
        return new Promise((resolve, reject) => {
            const term = `%${searchTerm}%`;
            db.all(
                `SELECT id, code, sku, name, uom, price, stock, reorderLevel,
                        category, description, isActive
                 FROM products 
                 WHERE isActive = 1 AND
                       (name LIKE ? OR code LIKE ? OR sku LIKE ? OR category LIKE ?)
                 ORDER BY name ASC`,
                [term, term, term, term],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    /**
     * Create new product
     * @param {Object} productData
     * @returns {Promise<Object>}
     */
    static create(productData) {
        const code = typeof productData.code === 'string' ? productData.code.trim() : '';
        const sku = typeof productData.sku === 'string' ? productData.sku.trim() : '';
        const name = typeof productData.name === 'string' ? productData.name.trim() : '';
        const uom = typeof productData.uom === 'string' ? productData.uom.trim() : 'pcs';
        const category = typeof productData.category === 'string' ? productData.category.trim() : 'General';
        const description = typeof productData.description === 'string' ? productData.description.trim() : '';
        const price = productData.price;
        const initialQty = productData.initialQty;
        const reorderLevel = productData.reorderLevel;
        const actor = productData.actor;

        if (!code || code.length > 120) return Promise.reject(new Error('Barcode is required and must be at most 120 characters'));
        if (sku.length > 80) return Promise.reject(new Error('SKU must be at most 80 characters'));
        if (name.length < 2 || name.length > 160) return Promise.reject(new Error('Item name must be 2-160 characters'));
        if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
            return Promise.reject(new Error('Price must be a non-negative number'));
        }
        if (!Number.isSafeInteger(initialQty) || initialQty < 0 ||
            !Number.isSafeInteger(reorderLevel) || reorderLevel < 0) {
            return Promise.reject(new Error('Initial quantity and reorder level must be non-negative whole numbers'));
        }
        if (!uom || uom.length > 30) return Promise.reject(new Error('Unit of measure is required and must be at most 30 characters'));
        if (!actor || !Number.isInteger(actor.id) || typeof actor.branch !== 'string') {
            return Promise.reject(new Error('Authenticated user and branch are required to create a product'));
        }

        return new Promise((resolve, reject) => {
            const connection = new sqlite3.Database(db.databasePath, async openError => {
                if (openError) return reject(openError);
                connection.configure('busyTimeout', 5000);
                const run = (sql, params = []) => new Promise((runResolve, runReject) => {
                    connection.run(sql, params, function(error) {
                        if (error) return runReject(error);
                        runResolve({ id: this.lastID, changes: this.changes });
                    });
                });
                const close = () => new Promise((closeResolve, closeReject) => {
                    connection.close(error => error ? closeReject(error) : closeResolve());
                });
                let started = false;
                let finished = false;
                try {
                    await run('PRAGMA foreign_keys = ON');
                    await run('BEGIN IMMEDIATE TRANSACTION');
                    started = true;
                    const inserted = await run(
                        `INSERT INTO products (
                            code, sku, name, price, stock, uom, reorderLevel, category, description
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [code, sku || null, name, price, initialQty, uom, reorderLevel, category || 'General', description]
                    );
                    if (initialQty > 0) {
                        await InventoryMovement.createOnConnection(connection, {
                            productId: inserted.id,
                            userId: actor.id,
                            branch: actor.branch,
                            movementType: 'OPENING',
                            quantityDelta: initialQty,
                            previousStock: 0,
                            newStock: initialQty,
                            reason: 'Opening quantity entered when product was created'
                        });
                    }
                    await AuditLog.createOnConnection(connection, {
                        eventType: 'PRODUCT_CREATED',
                        userId: actor.id,
                        branch: actor.branch,
                        productId: inserted.id,
                        reason: 'Product created',
                        details: { barcode: code, sku: sku || null, name, initialQty }
                    });
                    await run('COMMIT');
                    finished = true;
                    await close();
                    resolve({
                        id: inserted.id,
                        code,
                        sku: sku || null,
                        name,
                        uom,
                        price,
                        stock: initialQty,
                        reorderLevel,
                        category: category || 'General'
                    });
                } catch (error) {
                    if (started && !finished) {
                        try {
                            await run('ROLLBACK');
                            finished = true;
                        } catch (rollbackError) {
                            console.error('Product creation rollback failed:', rollbackError);
                            error.message = `${error.message}; rollback failed: ${rollbackError.message}`;
                        }
                    }
                    try {
                        await close();
                    } catch (closeError) {
                        console.error('Product creation database cleanup failed:', closeError);
                        error.message = `${error.message}; cleanup failed: ${closeError.message}`;
                    }
                    if (/UNIQUE constraint failed: products\.(code|sku)/i.test(error.message)) {
                        error.message = 'Barcode or SKU already exists';
                    }
                    reject(error);
                }
            });
        });
    }

    /**
     * Update product
     * @param {number} id
     * @param {Object} updates
     * @returns {Promise<Object>}
     */
    static update(id, updates, actor) {
        if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
            return Promise.reject(new Error('Product updates are invalid'));
        }
        if (Object.hasOwn(updates, 'stock')) {
            return Promise.reject(new Error('Stock cannot be edited in the product form; use an inventory movement'));
        }
        if (!actor || !Number.isInteger(actor.id) || typeof actor.branch !== 'string') {
            return Promise.reject(new Error('Authenticated user and branch are required to update a product'));
        }

        const allowedFields = ['code', 'sku', 'name', 'price', 'uom', 'reorderLevel', 'category', 'description'];
        const updateData = {};
        for (const field of allowedFields) {
            if (!(field in updates)) continue;
            if (field === 'code') {
                if (typeof updates[field] !== 'string' || !updates[field].trim() || updates[field].trim().length > 120) {
                    return Promise.reject(new Error('Barcode is required and must be at most 120 characters'));
                }
                updateData[field] = updates[field].trim();
                continue;
            }
            if (field === 'sku') {
                if (updates[field] !== null &&
                    (typeof updates[field] !== 'string' || updates[field].trim().length > 80)) {
                    return Promise.reject(new Error('SKU must be at most 80 characters'));
                }
                updateData[field] = typeof updates[field] === 'string' && updates[field].trim()
                    ? updates[field].trim()
                    : null;
                continue;
            }
            if (field === 'name' &&
                (typeof updates[field] !== 'string' || updates[field].trim().length < 2 || updates[field].trim().length > 160)) {
                return Promise.reject(new Error('Item name must be 2-160 characters'));
            }
            if (field === 'uom' &&
                (typeof updates[field] !== 'string' || !updates[field].trim() || updates[field].trim().length > 30)) {
                return Promise.reject(new Error('Unit of measure is required and must be at most 30 characters'));
            }
            if (field === 'price' &&
                (typeof updates[field] !== 'number' || !Number.isFinite(updates[field]) || updates[field] < 0)) {
                return Promise.reject(new Error('Price must be a non-negative number'));
            }
            if (field === 'reorderLevel' && (!Number.isSafeInteger(updates[field]) || updates[field] < 0)) {
                return Promise.reject(new Error('Reorder level must be a non-negative whole number'));
            }
            updateData[field] = ['name', 'uom', 'category', 'description'].includes(field)
                ? String(updates[field]).trim()
                : updates[field];
        }
        if (Object.keys(updateData).length === 0) {
            return Promise.reject(new Error('No valid fields to update'));
        }

        return new Promise((resolve, reject) => {
            const connection = new sqlite3.Database(db.databasePath, async openError => {
                if (openError) return reject(openError);
                connection.configure('busyTimeout', 5000);
                const run = (sql, params = []) => new Promise((runResolve, runReject) => {
                    connection.run(sql, params, function(error) {
                        if (error) return runReject(error);
                        runResolve({ changes: this.changes });
                    });
                });
                const get = (sql, params = []) => new Promise((getResolve, getReject) => {
                    connection.get(sql, params, (error, row) => error ? getReject(error) : getResolve(row));
                });
                const close = () => new Promise((closeResolve, closeReject) => {
                    connection.close(error => error ? closeReject(error) : closeResolve());
                });
                let started = false;
                let finished = false;
                try {
                    await run('PRAGMA foreign_keys = ON');
                    await run('BEGIN IMMEDIATE TRANSACTION');
                    started = true;
                    const previous = await get(
                        `SELECT id, code, sku, name, uom, price, stock, reorderLevel, category, description, isActive
                         FROM products WHERE id = ?`,
                        [id]
                    );
                    if (!previous) throw new Error('Product not found');
                    const fields = Object.keys(updateData);
                    const result = await run(
                        `UPDATE products SET ${fields.map(field => `${field} = ?`).join(', ')},
                             updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
                        [...fields.map(field => updateData[field]), id]
                    );
                    if (result.changes !== 1) throw new Error('Product could not be updated');
                    await AuditLog.createOnConnection(connection, {
                        eventType: 'PRODUCT_UPDATED',
                        userId: actor.id,
                        branch: actor.branch,
                        productId: id,
                        reason: 'Product details updated',
                        details: {
                            barcode: previous.code,
                            changedFields: Object.fromEntries(fields.map(field => [
                                field,
                                { from: previous[field], to: updateData[field] }
                            ]))
                        }
                    });
                    await run('COMMIT');
                    finished = true;
                    await close();
                    resolve({ id, ...updateData });
                } catch (error) {
                    if (/UNIQUE constraint failed: products\.(code|sku)/i.test(error.message)) {
                        error.message = 'Barcode or SKU already exists';
                    }
                    if (started && !finished) {
                        try {
                            await run('ROLLBACK');
                            finished = true;
                        } catch (rollbackError) {
                            console.error('Product update rollback failed:', rollbackError);
                            error.message = `${error.message}; rollback failed: ${rollbackError.message}`;
                        }
                    }
                    try {
                        await close();
                    } catch (closeError) {
                        console.error('Product update database cleanup failed:', closeError);
                        error.message = `${error.message}; cleanup failed: ${closeError.message}`;
                    }
                    reject(error);
                }
            });
        });
    }

    /**
     * Deactivate product (soft delete)
     * @param {number} id
     * @returns {Promise<Object>}
     */
    static deactivate(id, actor) {
        if (!actor || !Number.isInteger(actor.id) || typeof actor.branch !== 'string') {
            return Promise.reject(new Error('Authenticated user and branch are required to deactivate a product'));
        }
        return new Promise((resolve, reject) => {
            const connection = new sqlite3.Database(db.databasePath, async openError => {
                if (openError) return reject(openError);
                connection.configure('busyTimeout', 5000);
                const run = (sql, params = []) => new Promise((runResolve, runReject) => {
                    connection.run(sql, params, function(error) {
                        if (error) return runReject(error);
                        runResolve({ changes: this.changes });
                    });
                });
                const get = (sql, params = []) => new Promise((getResolve, getReject) => {
                    connection.get(sql, params, (error, row) => error ? getReject(error) : getResolve(row));
                });
                const close = () => new Promise((closeResolve, closeReject) => {
                    connection.close(error => error ? closeReject(error) : closeResolve());
                });
                let started = false;
                let finished = false;
                try {
                    await run('PRAGMA foreign_keys = ON');
                    await run('BEGIN IMMEDIATE TRANSACTION');
                    started = true;
                    const product = await get(
                        'SELECT id, code, sku, name, isActive FROM products WHERE id = ?',
                        [id]
                    );
                    if (!product) throw new Error('Product not found');
                    if (!product.isActive) throw new Error('Product is already deactivated');
                    const result = await run(
                        `UPDATE products SET isActive = 0, updatedAt = CURRENT_TIMESTAMP
                         WHERE id = ? AND isActive = 1`,
                        [id]
                    );
                    if (result.changes !== 1) throw new Error('Product could not be deactivated');
                    await AuditLog.createOnConnection(connection, {
                        eventType: 'PRODUCT_DEACTIVATED',
                        userId: actor.id,
                        branch: actor.branch,
                        productId: id,
                        reason: 'Product deactivated',
                        details: { barcode: product.code, sku: product.sku, name: product.name }
                    });
                    await run('COMMIT');
                    finished = true;
                    await close();
                    resolve({ id, isActive: false });
                } catch (error) {
                    if (started && !finished) {
                        try {
                            await run('ROLLBACK');
                            finished = true;
                        } catch (rollbackError) {
                            console.error('Product deactivation rollback failed:', rollbackError);
                            error.message = `${error.message}; rollback failed: ${rollbackError.message}`;
                        }
                    }
                    try {
                        await close();
                    } catch (closeError) {
                        console.error('Product deactivation database cleanup failed:', closeError);
                        error.message = `${error.message}; cleanup failed: ${closeError.message}`;
                    }
                    reject(error);
                }
            });
        });
    }

    /**
     * Update stock after sale
     * @param {number} id
     * @param {number} quantity
     * @returns {Promise<Object>}
     */
    static updateStock(id, quantityDelta, reason, user) {
        return new Promise((resolve, reject) => {
            if (!Number.isSafeInteger(quantityDelta) || quantityDelta === 0) {
                return reject(new Error('Inventory adjustment must be a non-zero whole number'));
            }
            if (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 200) {
                return reject(new Error('Stock adjustment reason must be 5-200 characters'));
            }
            if (!user || !Number.isInteger(user.id) || typeof user.branch !== 'string') {
                return reject(new Error('Authenticated user and branch are required'));
            }

            const transactionDb = new sqlite3.Database(db.databasePath, openError => {
                if (openError) return reject(openError);
                transactionDb.configure('busyTimeout', 5000);
                transactionDb.run('PRAGMA foreign_keys = ON', pragmaError => {
                    if (pragmaError) return transactionDb.close(() => reject(pragmaError));
                    transactionDb.run('BEGIN IMMEDIATE TRANSACTION', beginError => {
                        if (beginError) return transactionDb.close(() => reject(beginError));
                        adjustStock();
                    });
                });
            });

            let finished = false;
            const rollback = error => {
                if (finished) return;
                finished = true;
                transactionDb.run('ROLLBACK', rollbackError => {
                    transactionDb.close(closeError => {
                        if (rollbackError || closeError) {
                            const cleanupError = rollbackError || closeError;
                            console.error('Stock adjustment rollback/cleanup failed:', cleanupError);
                            error.message = `${error.message}; cleanup failed: ${cleanupError.message}`;
                        }
                        reject(error);
                    });
                });
            };
            const commit = result => {
                transactionDb.run('COMMIT', commitError => {
                    if (commitError) return rollback(commitError);
                    finished = true;
                    transactionDb.close(closeError => {
                        if (closeError) {
                            console.error('Stock adjustment committed but connection close failed:', closeError);
                            return reject(closeError);
                        }
                        resolve(result);
                    });
                });
            };

            function adjustStock() {
                transactionDb.get(
                    'SELECT id, code, name, stock FROM products WHERE id = ? AND isActive = 1',
                    [id],
                    (selectError, product) => {
                        if (selectError) return rollback(selectError);
                        if (!product) return rollback(new Error('Active product not found'));

                        const newStock = product.stock + quantityDelta;
                        if (!Number.isSafeInteger(newStock) || newStock < 0) {
                            return rollback(new Error('Inventory adjustment would make stock negative or exceed the supported range'));
                        }

                        transactionDb.run(
                            `UPDATE products SET stock = ?, updatedAt = CURRENT_TIMESTAMP
                             WHERE id = ? AND isActive = 1`,
                            [newStock, id],
                            function(updateError) {
                                if (updateError) return rollback(updateError);
                                if (this.changes !== 1) return rollback(new Error('Product could not be updated'));

                                const movementType = quantityDelta > 0 ? 'MANUAL_ADD' : 'MANUAL_REMOVE';
                                InventoryMovement.createOnConnection(transactionDb, {
                                    productId: id,
                                    userId: user.id,
                                    branch: user.branch,
                                    movementType,
                                    quantityDelta,
                                    previousStock: product.stock,
                                    newStock,
                                    reason: reason.trim()
                                }).then(() => {
                                    return AuditLog.createOnConnection(transactionDb, {
                                        eventType: 'STOCK_ADJUSTED',
                                        userId: user.id,
                                        branch: user.branch,
                                        productId: id,
                                        reason: reason.trim(),
                                        details: {
                                            productCode: product.code,
                                            productName: product.name,
                                            adjustment: quantityDelta,
                                            previousStock: product.stock,
                                            newStock
                                        }
                                    }).then(() => {
                                        return commit({
                                        id,
                                        quantityAdjusted: quantityDelta,
                                        previousStock: product.stock,
                                        stock: newStock
                                        });
                                    });
                                }).catch(rollback);
                            }
                        );
                    }
                );
            }
        });
    }

    /**
     * Get low stock products
     * @param {number} threshold
     * @returns {Promise<Array>}
     */
    static getLowStock(threshold = 10) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT id, code, sku, name, uom, price, stock, reorderLevel, category
                 FROM products
                 WHERE stock <= CASE WHEN reorderLevel > 0 THEN reorderLevel ELSE ? END
                   AND isActive = 1
                 ORDER BY stock ASC`,
                [threshold],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    static getMovements({ branch, productId, limit, offset }) {
        return InventoryMovement.getAll({ branch, productId, limit, offset });
    }
}

module.exports = Product;
