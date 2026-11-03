const db = require('../database');

class AuditLog {
    static createOnConnection(connection, event) {
        return new Promise((resolve, reject) => {
            const {
                eventType,
                userId,
                branch,
                transactionId = null,
                productId = null,
                reason,
                details = {}
            } = event;

            connection.run(
                `INSERT INTO auditLogs (
                    eventType, userId, branch, transactionId, productId, reason, details
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    eventType,
                    userId,
                    branch,
                    transactionId,
                    productId,
                    reason,
                    JSON.stringify(details)
                ],
                function(error) {
                    if (error) reject(error);
                    else resolve({ id: this.lastID });
                }
            );
        });
    }

    static getAll({ branch, limit = 100, offset = 0 }) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT auditLogs.id, auditLogs.eventType, auditLogs.userId,
                        users.username, users.name AS userName, auditLogs.branch,
                        auditLogs.transactionId, auditLogs.productId, auditLogs.reason,
                        auditLogs.details, auditLogs.createdAt
                 FROM auditLogs
                 INNER JOIN users ON users.id = auditLogs.userId
                 WHERE auditLogs.branch = ?
                 ORDER BY auditLogs.id DESC
                 LIMIT ? OFFSET ?`,
                [branch, limit, offset],
                (error, rows) => {
                    if (error) return reject(error);
                    try {
                        resolve((rows || []).map(row => ({
                            ...row,
                            details: JSON.parse(row.details)
                        })));
                    } catch (parseError) {
                        reject(parseError);
                    }
                }
            );
        });
    }
}

module.exports = AuditLog;
