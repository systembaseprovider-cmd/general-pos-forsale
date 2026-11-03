const db = require('../database');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const AuditLog = require('./AuditLog');
const {
    DEFAULT_CASHIER_PERMISSIONS,
    normalizeModulePermissions
} = require('../services/modulePermissions');

// ========================================
// USER MODEL
// ========================================

class User {
    /**
     * Find user by username
     * @param {string} username
     * @returns {Promise<Object|null>}
     */
    static findByUsername(username) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT id, username, password, name, role, branch, isActive,
                        tokenVersion, modulePermissions
                 FROM users WHERE username = ? AND isActive = 1`,
                [username],
                (err, row) => {
                    if (err) return reject(err);
                    if (!row) return resolve(null);
                    row.modulePermissions = normalizeModulePermissions(row.modulePermissions);
                    resolve(row);
                }
            );
        });
    }

    /**
     * Verify password against hashed password
     * @param {string} plainPassword
     * @param {string} hashedPassword
     * @returns {boolean}
     */
    static verifyPassword(plainPassword, hashedPassword) {
        return bcrypt.compareSync(plainPassword, hashedPassword);
    }

    /**
     * Create new user with hashed password
     * @param {string} username
     * @param {string} password
     * @param {string} name
     * @param {string} role
     * @param {string} branch
     * @returns {Promise<Object>}
     */
    static create(
        username,
        password,
        name,
        role = 'cashier',
        branch = '01',
        modulePermissions = DEFAULT_CASHIER_PERMISSIONS,
        createdBy = null
    ) {
        if (typeof username !== 'string' || username.trim().length < 3 || username.trim().length > 64) {
            return Promise.reject(new Error('Username must be 3-64 characters'));
        }
        if (typeof password !== 'string' || password.length < 8 || password === 'admin123') {
            return Promise.reject(new Error('Password/PIN must be at least 8 characters and must not use the legacy default'));
        }
        if (typeof name !== 'string' || name.trim().length < 2) {
            return Promise.reject(new Error('Name is required'));
        }
        if (!['admin', 'cashier'].includes(role)) {
            return Promise.reject(new Error('Role must be admin or cashier'));
        }
        if (typeof branch !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(branch)) {
            return Promise.reject(new Error('Branch must be 1-20 letters, numbers, underscores, or hyphens'));
        }

        const normalizedUsername = username.trim();
        const normalizedName = name.trim();
        const normalizedPermissions = normalizeModulePermissions(modulePermissions);
        if (role === 'admin') {
            Object.keys(normalizedPermissions).forEach(module => { normalizedPermissions[module] = true; });
        }
        const hashedPassword = bcrypt.hashSync(password, 12);

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
                        `INSERT INTO users (username, password, name, role, branch, modulePermissions)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [normalizedUsername, hashedPassword, normalizedName, role, branch, JSON.stringify(normalizedPermissions)]
                    );
                    await AuditLog.createOnConnection(connection, {
                        eventType: 'USER_CREATED',
                        userId: createdBy?.id || inserted.id,
                        branch,
                        reason: 'Administrator created user account',
                        details: {
                            targetUserId: inserted.id,
                            username: normalizedUsername,
                            name: normalizedName,
                            role,
                            modulePermissions: normalizedPermissions
                        }
                    });
                    await run('COMMIT');
                    finished = true;
                    await close();
                    resolve({
                        id: inserted.id,
                        username: normalizedUsername,
                        name: normalizedName,
                        role,
                        branch,
                        modulePermissions: normalizedPermissions
                    });
                } catch (error) {
                    if (/UNIQUE constraint failed: users\.username/i.test(error.message)) {
                        error.message = 'Username already exists';
                    }
                    if (started && !finished) {
                        try {
                            await run('ROLLBACK');
                            finished = true;
                        } catch (rollbackError) {
                            console.error('User creation rollback failed:', rollbackError);
                            error.message = `${error.message}; rollback failed: ${rollbackError.message}`;
                        }
                    }
                    try {
                        await close();
                    } catch (closeError) {
                        console.error('User creation database cleanup failed:', closeError);
                        error.message = `${error.message}; cleanup failed: ${closeError.message}`;
                    }
                    reject(error);
                }
            });
        });
    }

    /**
     * Get user by ID
     * @param {number} id
     * @returns {Promise<Object|null>}
     */
    static findById(id) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT id, username, name, role, branch, isActive, createdAt,
                        tokenVersion, modulePermissions
                 FROM users WHERE id = ? AND isActive = 1`,
                [id],
                (err, row) => {
                    if (err) return reject(err);
                    if (!row) return resolve(null);
                    row.modulePermissions = normalizeModulePermissions(row.modulePermissions);
                    resolve(row);
                }
            );
        });
    }

    static listByBranch(branch) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT id, username, name, role, branch, isActive, createdAt,
                        modulePermissions
                 FROM users WHERE branch = ? ORDER BY name COLLATE NOCASE`,
                [branch],
                (error, rows) => {
                    if (error) return reject(error);
                    resolve((rows || []).map(row => ({
                        ...row,
                        isActive: Boolean(row.isActive),
                        modulePermissions: normalizeModulePermissions(row.modulePermissions)
                    })));
                }
            );
        });
    }

    static updateManaged({ id, branch, actorId, name, username, role, password, modulePermissions, isActive }) {
        if (!Number.isSafeInteger(id) || id <= 0 ||
            typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120 ||
            typeof username !== 'string' || !/^[A-Za-z0-9._-]{3,64}$/.test(username.trim()) ||
            !['admin', 'cashier'].includes(role) || typeof isActive !== 'boolean') {
            return Promise.reject(new Error('User details are invalid'));
        }
        if (password !== undefined && password !== '' &&
            (typeof password !== 'string' || password.length < 8)) {
            return Promise.reject(new Error('Password must be at least 8 characters'));
        }
        if (id === actorId && (role !== 'admin' || !isActive)) {
            return Promise.reject(new Error('You cannot remove your own administrator access'));
        }

        const permissions = normalizeModulePermissions(modulePermissions);
        if (role === 'admin') {
            Object.keys(permissions).forEach(module => { permissions[module] = true; });
        }
        const normalizedName = name.trim();
        const normalizedUsername = username.trim();
        const passwordHash = password ? bcrypt.hashSync(password, 12) : null;

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
                    const existing = await get(
                        'SELECT id, name, username, role, isActive FROM users WHERE id = ? AND branch = ?',
                        [id, branch]
                    );
                    if (!existing) throw new Error('User not found in this branch');
                    if (existing.role === 'admin' && (role !== 'admin' || !isActive)) {
                        const admins = await get(
                            "SELECT COUNT(*) AS count FROM users WHERE branch = ? AND role = 'admin' AND isActive = 1",
                            [branch]
                        );
                        if (Number(admins.count) <= 1) throw new Error('Cannot remove or disable the last active administrator');
                    }

                    const result = await run(
                        `UPDATE users
                         SET name = ?, username = ?, role = ?, modulePermissions = ?,
                             isActive = ?, password = COALESCE(?, password),
                             tokenVersion = tokenVersion + 1, updatedAt = CURRENT_TIMESTAMP
                         WHERE id = ? AND branch = ?`,
                        [
                            normalizedName,
                            normalizedUsername,
                            role,
                            JSON.stringify(permissions),
                            isActive ? 1 : 0,
                            passwordHash,
                            id,
                            branch
                        ]
                    );
                    if (result.changes !== 1) throw new Error('User could not be updated');

                    await AuditLog.createOnConnection(connection, {
                        eventType: 'USER_UPDATED',
                        userId: actorId,
                        branch,
                        reason: 'Administrator updated user access',
                        details: {
                            targetUserId: id,
                            previousUsername: existing.username,
                            username: normalizedUsername,
                            previousRole: existing.role,
                            role,
                            isActive,
                            modulePermissions: permissions,
                            passwordReset: Boolean(passwordHash)
                        }
                    });
                    await run('COMMIT');
                    finished = true;
                    await close();
                    resolve({
                        id,
                        name: normalizedName,
                        username: normalizedUsername,
                        role,
                        branch,
                        isActive,
                        modulePermissions: permissions
                    });
                } catch (error) {
                    if (/UNIQUE constraint failed: users\.username/i.test(error.message)) {
                        error.message = 'Username already exists';
                    }
                    if (started && !finished) {
                        try {
                            await run('ROLLBACK');
                            finished = true;
                        } catch (rollbackError) {
                            console.error('User update rollback failed:', rollbackError);
                            error.message = `${error.message}; rollback failed: ${rollbackError.message}`;
                        }
                    }
                    try {
                        await close();
                    } catch (closeError) {
                        console.error('User update database cleanup failed:', closeError);
                        error.message = `${error.message}; cleanup failed: ${closeError.message}`;
                    }
                    reject(error);
                }
            });
        });
    }

    static updatePassword(id, newPassword) {
        return new Promise((resolve, reject) => {
            if (typeof newPassword !== 'string' || newPassword.length < 8) {
                return reject(new Error('New password/PIN must be at least 8 characters'));
            }

            const hashedPassword = bcrypt.hashSync(newPassword, 12);
            db.run(
                `UPDATE users SET password = ?, tokenVersion = tokenVersion + 1,
                    updatedAt = CURRENT_TIMESTAMP
                 WHERE id = ? AND isActive = 1`,
                [hashedPassword, id],
                function(err) {
                    if (err) reject(err);
                    else if (this.changes === 0) reject(new Error('User not found'));
                    else resolve({ success: true });
                }
            );
        });
    }
}

module.exports = User;
