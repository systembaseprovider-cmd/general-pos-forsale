const db = require('../database');

class InventoryMovement {
    static createOnConnection(connection, movement) {
        const {
            productId,
            userId = null,
            branch,
            movementType,
            quantityDelta,
            previousStock,
            newStock,
            reason,
            reference = null
        } = movement;

        return new Promise((resolve, reject) => {
            connection.run(
                `INSERT INTO inventoryMovements (
                    productId, userId, branch, movementType, quantityDelta,
                    previousStock, newStock, reason, reference
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    productId,
                    userId,
                    branch,
                    movementType,
                    quantityDelta,
                    previousStock,
                    newStock,
                    reason,
                    reference
                ],
                function(error) {
                    if (error) reject(error);
                    else resolve({ id: this.lastID });
                }
            );
        });
    }

    static getAll({ branch, productId, limit = 100, offset = 0 }) {
        const conditions = [];
        const values = [];
        if (branch) {
            conditions.push('inventoryMovements.branch IN (?, ?)');
            values.push(branch, 'GLOBAL');
        }
        if (productId) {
            conditions.push('inventoryMovements.productId = ?');
            values.push(productId);
        }
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT inventoryMovements.id, inventoryMovements.productId,
                        products.code AS barcode, products.sku, products.name AS itemName,
                        products.uom, inventoryMovements.userId, users.name AS userName,
                        inventoryMovements.branch, inventoryMovements.movementType,
                        inventoryMovements.quantityDelta, inventoryMovements.previousStock,
                        inventoryMovements.newStock, inventoryMovements.reason,
                        inventoryMovements.reference, inventoryMovements.createdAt
                 FROM inventoryMovements
                 INNER JOIN products ON products.id = inventoryMovements.productId
                 LEFT JOIN users ON users.id = inventoryMovements.userId
                 ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
                 ORDER BY inventoryMovements.id DESC LIMIT ? OFFSET ?`,
                [...values, limit, offset],
                (error, rows) => error ? reject(error) : resolve(rows || [])
            );
        });
    }
}

module.exports = InventoryMovement;
