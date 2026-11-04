const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Create database connection
const dbPath = process.env.POS_DB_PATH || path.join(__dirname, '..', 'pos.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Database connection error:', err.message);
    } else {
        console.log('Connected to SQLite database at:', dbPath);
    }
});
db.databasePath = dbPath;
let resolveDatabaseReady;
let rejectDatabaseReady;
db.ready = new Promise((resolve, reject) => {
    resolveDatabaseReady = resolve;
    rejectDatabaseReady = reject;
});
let resolveAdminBootstrap;
let rejectAdminBootstrap;
const adminBootstrapReady = new Promise((resolve, reject) => {
    resolveAdminBootstrap = resolve;
    rejectAdminBootstrap = reject;
});
let resolveProductSeed;
let rejectProductSeed;
const productSeedReady = new Promise((resolve, reject) => {
    resolveProductSeed = resolve;
    rejectProductSeed = reject;
});
let resolveAuditTable;
let rejectAuditTable;
const auditTableReady = new Promise((resolve, reject) => {
    resolveAuditTable = resolve;
    rejectAuditTable = reject;
});
let resolveRefundTables;
let rejectRefundTables;
const refundTablesReady = new Promise((resolve, reject) => {
    resolveRefundTables = resolve;
    rejectRefundTables = reject;
});
let resolveInventoryTable;
let rejectInventoryTable;
const inventoryTableReady = new Promise((resolve, reject) => {
    resolveInventoryTable = resolve;
    rejectInventoryTable = reject;
});
let resolveSettingsTable;
let rejectSettingsTable;
const settingsTableReady = new Promise((resolve, reject) => {
    resolveSettingsTable = resolve;
    rejectSettingsTable = reject;
});
let resolveLegacyTransactionImports;
let rejectLegacyTransactionImports;
const legacyTransactionImportsReady = new Promise((resolve, reject) => {
    resolveLegacyTransactionImports = resolve;
    rejectLegacyTransactionImports = reject;
});
let resolveDailyClosures;
let rejectDailyClosures;
const dailyClosuresReady = new Promise((resolve, reject) => {
    resolveDailyClosures = resolve;
    rejectDailyClosures = reject;
});
let resolveCommerceTables;
let rejectCommerceTables;
const commerceTablesReady = new Promise((resolve, reject) => {
    resolveCommerceTables = resolve;
    rejectCommerceTables = reject;
});

// Enable foreign keys
db.run('PRAGMA foreign_keys = ON');

// ========================================
// CREATE TABLES
// ========================================

db.serialize(() => {
    // USERS TABLE
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT NOT NULL,
            role TEXT DEFAULT 'cashier',
            branch TEXT DEFAULT '01',
            isActive BOOLEAN DEFAULT 1,
            tokenVersion INTEGER NOT NULL DEFAULT 0,
            modulePermissions TEXT NOT NULL DEFAULT '{"pos":true,"inventory":false,"products":false,"reports":true}',
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.error('Users table error:', err.message);
        else console.log('✓ Users table ready');
    });

    // PRODUCTS TABLE
    db.run(`
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            sku TEXT UNIQUE,
            name TEXT NOT NULL,
            price REAL NOT NULL CHECK(price >= 0),
            stock INTEGER DEFAULT 0 CHECK(stock >= 0),
            uom TEXT NOT NULL DEFAULT 'pcs',
            reorderLevel INTEGER NOT NULL DEFAULT 0 CHECK(reorderLevel >= 0),
            category TEXT DEFAULT 'General',
            description TEXT,
            isActive BOOLEAN DEFAULT 1,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.error('Products table error:', err.message);
        else console.log('✓ Products table ready');
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS inventoryMovements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            productId INTEGER NOT NULL,
            userId INTEGER,
            branch TEXT NOT NULL,
            movementType TEXT NOT NULL CHECK(movementType IN (
                'BASELINE', 'OPENING', 'MANUAL_ADD', 'MANUAL_REMOVE', 'SALE', 'REFUND', 'VOID'
            )),
            quantityDelta INTEGER NOT NULL CHECK(quantityDelta != 0),
            previousStock INTEGER NOT NULL CHECK(previousStock >= 0),
            newStock INTEGER NOT NULL CHECK(newStock >= 0),
            reason TEXT NOT NULL,
            reference TEXT,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(productId) REFERENCES products(id),
            FOREIGN KEY(userId) REFERENCES users(id)
        )
    `, err => {
        if (err) {
            console.error('Inventory movements table error:', err.message);
            rejectInventoryTable(err);
        } else {
            db.run(
                `CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_baseline_product
                 ON inventoryMovements(productId) WHERE movementType = 'BASELINE'`,
                indexError => {
                    if (indexError) {
                        console.error('Inventory baseline index error:', indexError.message);
                        rejectInventoryTable(indexError);
                    } else {
                        console.log('✓ Inventory movements table ready');
                        resolveInventoryTable();
                    }
                }
            );
        }
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS appSettings (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            appName TEXT NOT NULL DEFAULT 'pos-catalog.com',
            logoDataUrl TEXT,
            address TEXT NOT NULL DEFAULT '',
            tin TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            receiptFooter TEXT NOT NULL DEFAULT 'Thank you for your purchase!',
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `, err => {
        if (err) {
            console.error('App settings table error:', err.message);
            rejectSettingsTable(err);
        } else {
            db.run(
                `INSERT OR IGNORE INTO appSettings (id) VALUES (1)`,
                insertError => {
                    if (insertError) {
                        console.error('App settings initialization error:', insertError.message);
                        rejectSettingsTable(insertError);
                    } else {
                        console.log('✓ App settings table ready');
                        resolveSettingsTable();
                    }
                }
            );
        }
    });

    // TRANSACTIONS TABLE
    db.run(`
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            txnNo TEXT UNIQUE NOT NULL,
            userId INTEGER NOT NULL,
            cashierName TEXT NOT NULL,
            customerName TEXT DEFAULT 'GUEST CUSTOMER',
            subtotal REAL NOT NULL CHECK(subtotal >= 0),
            discountAmount REAL DEFAULT 0 CHECK(discountAmount >= 0),
            vatableSales REAL NOT NULL CHECK(vatableSales >= 0),
            vatAmount REAL NOT NULL CHECK(vatAmount >= 0),
            totalAmount REAL NOT NULL CHECK(totalAmount >= 0),
            paymentMethod TEXT NOT NULL,
            tenderedAmount REAL NOT NULL DEFAULT 0 CHECK(tenderedAmount >= 0),
            changeAmount REAL NOT NULL DEFAULT 0 CHECK(changeAmount >= 0),
            branch TEXT NOT NULL DEFAULT '01',
            requestHash TEXT,
            voidedAt DATETIME,
            voidReason TEXT,
            voidedBy INTEGER,
            voidRequestId TEXT,
            voidRequestHash TEXT,
            referenceNo TEXT,
            notes TEXT,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(userId) REFERENCES users(id)
        )
    `, (err) => {
        if (err) console.error('Transactions table error:', err.message);
        else console.log('✓ Transactions table ready');
    });

    // TRANSACTION ITEMS TABLE (Line items in each transaction)
    db.run(`
        CREATE TABLE IF NOT EXISTS transactionItems (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transactionId INTEGER NOT NULL,
            productId INTEGER NOT NULL,
            productCode TEXT NOT NULL,
            productName TEXT NOT NULL,
            unitPrice REAL NOT NULL CHECK(unitPrice >= 0),
            quantity INTEGER NOT NULL CHECK(quantity > 0),
            lineTotal REAL NOT NULL CHECK(lineTotal >= 0),
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE,
            FOREIGN KEY(productId) REFERENCES products(id)
        )
    `, (err) => {
        if (err) console.error('Transaction Items table error:', err.message);
        else console.log('✓ Transaction Items table ready');
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS legacyTransactionImports (
            sourceFingerprint TEXT NOT NULL,
            sourcePath TEXT NOT NULL,
            sourceTransactionId INTEGER NOT NULL,
            targetTransactionId INTEGER NOT NULL UNIQUE,
            originalTxnNo TEXT NOT NULL,
            importedTxnNo TEXT NOT NULL,
            importedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(sourceFingerprint, sourceTransactionId),
            UNIQUE(sourcePath, sourceTransactionId),
            FOREIGN KEY(targetTransactionId) REFERENCES transactions(id) ON DELETE CASCADE
        )
    `, err => {
        if (err) {
            console.error('Legacy transaction import table error:', err.message);
            rejectLegacyTransactionImports(err);
        } else {
            resolveLegacyTransactionImports();
        }
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS dailyClosures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            branch TEXT NOT NULL,
            businessDate TEXT NOT NULL CHECK(
                length(businessDate) = 10 AND
                businessDate GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            ),
            closedBy INTEGER NOT NULL,
            closedByName TEXT NOT NULL,
            closedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            snapshotJson TEXT NOT NULL,
            UNIQUE(branch, businessDate),
            FOREIGN KEY(closedBy) REFERENCES users(id)
        )
    `, err => {
        if (err) {
            console.error('Daily closures table error:', err.message);
            rejectDailyClosures(err);
        } else {
            resolveDailyClosures();
        }
    });

    // Suppliers, receiving records, and loyalty profiles are deliberately local-first.
    // This lets a store continue receiving stock and serving members without internet access.
    db.run(`
        CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            contactName TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
            isActive BOOLEAN NOT NULL DEFAULT 1,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `, supplierError => {
        if (supplierError) return rejectCommerceTables(supplierError);
        db.run(`CREATE TABLE IF NOT EXISTS purchaseReceipts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            receiptNo TEXT NOT NULL UNIQUE, supplierId INTEGER NOT NULL, userId INTEGER NOT NULL,
            branch TEXT NOT NULL, supplierInvoiceNo TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
            totalCost REAL NOT NULL DEFAULT 0 CHECK(totalCost >= 0), receivedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(supplierId) REFERENCES suppliers(id), FOREIGN KEY(userId) REFERENCES users(id)
        )`, receiptError => {
            if (receiptError) return rejectCommerceTables(receiptError);
            db.run(`CREATE TABLE IF NOT EXISTS purchaseReceiptItems (
                id INTEGER PRIMARY KEY AUTOINCREMENT, purchaseReceiptId INTEGER NOT NULL,
                productId INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0),
                unitCost REAL NOT NULL DEFAULT 0 CHECK(unitCost >= 0),
                FOREIGN KEY(purchaseReceiptId) REFERENCES purchaseReceipts(id) ON DELETE CASCADE,
                FOREIGN KEY(productId) REFERENCES products(id), UNIQUE(purchaseReceiptId, productId)
            )`, itemError => {
                if (itemError) return rejectCommerceTables(itemError);
                db.run(`CREATE TABLE IF NOT EXISTS customers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
                    loyaltyPoints INTEGER NOT NULL DEFAULT 0 CHECK(loyaltyPoints >= 0),
                    isActive BOOLEAN NOT NULL DEFAULT 1,
                    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                )`, customerError => {
                    if (customerError) rejectCommerceTables(customerError);
                    else resolveCommerceTables();
                });
            });
        });
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS auditLogs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            eventType TEXT NOT NULL,
            userId INTEGER NOT NULL,
            branch TEXT NOT NULL,
            transactionId INTEGER,
            productId INTEGER,
            reason TEXT NOT NULL,
            details TEXT NOT NULL DEFAULT '{}',
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(userId) REFERENCES users(id),
            FOREIGN KEY(transactionId) REFERENCES transactions(id),
            FOREIGN KEY(productId) REFERENCES products(id)
        )
    `, (err) => {
        if (err) {
            console.error('Audit log table error:', err.message);
            rejectAuditTable(err);
        } else {
            console.log('✓ Audit log table ready');
            resolveAuditTable();
        }
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS refunds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            requestId TEXT UNIQUE NOT NULL,
            requestHash TEXT NOT NULL,
            transactionId INTEGER NOT NULL,
            userId INTEGER NOT NULL,
            branch TEXT NOT NULL,
            refundAmount REAL NOT NULL CHECK(refundAmount > 0),
            reason TEXT NOT NULL,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(transactionId) REFERENCES transactions(id),
            FOREIGN KEY(userId) REFERENCES users(id)
        )
    `, (err) => {
        if (err) {
            console.error('Refunds table error:', err.message);
            rejectRefundTables(err);
            return;
        }
        db.run(`
            CREATE TABLE IF NOT EXISTS refundItems (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                refundId INTEGER NOT NULL,
                transactionItemId INTEGER NOT NULL,
                quantity INTEGER NOT NULL CHECK(quantity > 0),
                refundAmount REAL NOT NULL CHECK(refundAmount > 0),
                FOREIGN KEY(refundId) REFERENCES refunds(id),
                FOREIGN KEY(transactionItemId) REFERENCES transactionItems(id),
                UNIQUE(refundId, transactionItemId)
            )
        `, (itemsError) => {
            if (itemsError) {
                console.error('Refund items table error:', itemsError.message);
                rejectRefundTables(itemsError);
            } else {
                console.log('✓ Refund tables ready');
                resolveRefundTables();
            }
        });
    });

    // Migrate databases created before branch scoping and idempotent sales.
    db.all('PRAGMA table_info(transactions)', (err, columns) => {
        if (err) {
            console.error('Transactions migration check error:', err.message);
            rejectDatabaseReady(err);
            return;
        }

        const existingColumns = new Set(columns.map(column => column.name));
        const needsBranchMigration = !existingColumns.has('branch');
        const migrations = [];
        if (!existingColumns.has('branch')) {
            migrations.push(new Promise((resolve, reject) => {
                db.run("ALTER TABLE transactions ADD COLUMN branch TEXT NOT NULL DEFAULT '01'", (alterError) => {
                    if (alterError) reject(alterError);
                    else resolve();
                });
            }));
        }
        if (!existingColumns.has('requestHash')) {
            migrations.push(new Promise((resolve, reject) => {
                db.run('ALTER TABLE transactions ADD COLUMN requestHash TEXT', (alterError) => {
                    if (alterError) reject(alterError);
                    else resolve();
                });
            }));
        }
        for (const column of ['tenderedAmount', 'changeAmount']) {
            if (!existingColumns.has(column)) {
                migrations.push(new Promise((resolve, reject) => {
                    db.run(`ALTER TABLE transactions ADD COLUMN ${column} REAL NOT NULL DEFAULT 0`, (alterError) => {
                        if (alterError) reject(alterError);
                        else resolve();
                    });
                }));
            }
        }
        for (const [column, definition] of [
            ['voidedAt', 'DATETIME'],
            ['voidReason', 'TEXT'],
            ['voidedBy', 'INTEGER'],
            ['voidRequestId', 'TEXT'],
            ['voidRequestHash', 'TEXT']
        ]) {
            if (!existingColumns.has(column)) {
                migrations.push(new Promise((resolve, reject) => {
                    db.run(`ALTER TABLE transactions ADD COLUMN ${column} ${definition}`, alterError => {
                        if (alterError) reject(alterError);
                        else resolve();
                    });
                }));
            }
        }

        Promise.all(migrations)
            .then(() => new Promise((resolve, reject) => {
                db.run(
                    "UPDATE appSettings SET appName = 'pos-catalog.com' WHERE appName IN ('POS Store', 'mypos.com')",
                    error => error ? reject(error) : resolve()
                );
            }))
            .then(() => new Promise((resolve, reject) => {
                db.run(
                    `CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_void_request_id
                     ON transactions(voidRequestId) WHERE voidRequestId IS NOT NULL`,
                    indexError => indexError ? reject(indexError) : resolve()
                );
            }))
            .then(() => new Promise((resolve, reject) => {
                db.all('PRAGMA table_info(users)', (usersError, userColumns) => {
                     if (usersError) return reject(usersError);
                     const columnsByName = new Set(userColumns.map(column => column.name));
                     const userMigrations = [];
                     if (!columnsByName.has('tokenVersion')) {
                         userMigrations.push(new Promise((migrationResolve, migrationReject) => {
                             db.run(
                                 'ALTER TABLE users ADD COLUMN tokenVersion INTEGER NOT NULL DEFAULT 0',
                                 alterError => alterError ? migrationReject(alterError) : migrationResolve()
                             );
                         }));
                     }
                     if (!columnsByName.has('modulePermissions')) {
                         userMigrations.push(new Promise((migrationResolve, migrationReject) => {
                             db.run(
                                 `ALTER TABLE users ADD COLUMN modulePermissions TEXT NOT NULL
                                  DEFAULT '{"pos":true,"inventory":false,"products":false,"reports":true}'`,
                                 alterError => alterError ? migrationReject(alterError) : migrationResolve()
                             );
                         }));
                     }
                     Promise.all(userMigrations).then(resolve, reject);
                });
            }))
            .then(() => new Promise((resolve, reject) => {
                db.all('PRAGMA table_info(products)', (productsError, productColumns) => {
                    if (productsError) return reject(productsError);
                    const existingProductColumns = new Set(productColumns.map(column => column.name));
                    const productMigrations = [];
                    for (const [column, definition] of [
                        ['sku', 'TEXT'],
                        ['uom', "TEXT NOT NULL DEFAULT 'pcs'"],
                        ['reorderLevel', 'INTEGER NOT NULL DEFAULT 0']
                    ]) {
                        if (!existingProductColumns.has(column)) {
                            productMigrations.push(new Promise((migrationResolve, migrationReject) => {
                                db.run(
                                    `ALTER TABLE products ADD COLUMN ${column} ${definition}`,
                                    alterError => alterError ? migrationReject(alterError) : migrationResolve()
                                );
                            }));
                        }
                    }
                    Promise.all(productMigrations)
                        .then(() => new Promise((indexResolve, indexReject) => {
                            db.run(
                                `CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku
                                 ON products(sku) WHERE sku IS NOT NULL`,
                                indexError => indexError ? indexReject(indexError) : indexResolve()
                            );
                        }))
                        .then(resolve, reject);
                });
            }))
            .then(() => new Promise((resolve, reject) => {
                db.run(
                     `UPDATE transactions
                      SET branch = COALESCE(
                          (SELECT users.branch FROM users WHERE users.id = transactions.userId),
                          '01'
                      )
                      WHERE ? = 1 OR branch IS NULL OR branch = ''`,
                     [needsBranchMigration ? 1 : 0],
                     (updateError) => updateError ? reject(updateError) : resolve()
                );
            }))
            .then(() => Promise.all([
                adminBootstrapReady,
                productSeedReady,
                auditTableReady,
                refundTablesReady,
                inventoryTableReady,
                settingsTableReady,
                legacyTransactionImportsReady,
                dailyClosuresReady
                ,commerceTablesReady
            ]))
            .then(() => new Promise((resolve, reject) => {
                db.run(
                    `INSERT OR IGNORE INTO inventoryMovements (
                        productId, userId, branch, movementType, quantityDelta,
                        previousStock, newStock, reason, reference
                    )
                    SELECT id, NULL, 'GLOBAL', 'BASELINE', stock, 0, stock,
                           'Opening balance recorded when inventory tracking was enabled',
                           'INVENTORY_MIGRATION'
                    FROM products
                    WHERE stock > 0`,
                    error => error ? reject(error) : resolve()
                );
            }))
            .then(resolveDatabaseReady)
            .catch(migrationError => {
                console.error('Transactions migration error:', migrationError);
                rejectDatabaseReady(migrationError);
            });
    });

    // Create the first admin only from explicitly configured deployment credentials.
    db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
        if (err) {
            console.error('User bootstrap check error:', err.message);
            rejectAdminBootstrap(err);
            return;
        }
        if (row && row.count === 0 && process.env.POS_ADMIN_USERNAME && process.env.POS_ADMIN_PASSWORD) {
            const bcrypt = require('bcryptjs');
            const username = process.env.POS_ADMIN_USERNAME.trim();
            const password = process.env.POS_ADMIN_PASSWORD;
            const name = (process.env.POS_ADMIN_NAME || 'Administrator').trim();
            const branch = (process.env.POS_ADMIN_BRANCH || '01').trim();

            if (username.length < 3 || username.length > 64 ||
                password.length < 8 ||
                name.length < 2 || !/^[A-Za-z0-9_-]{1,20}$/.test(branch)) {
                console.error('Initial admin not created: configure username (3+), password (8+), name, and branch.');
                resolveAdminBootstrap();
                return;
            }

            const hashedPassword = bcrypt.hashSync(password, 12);
            db.run(
                `INSERT INTO users (username, password, name, role, branch) 
                 VALUES (?, ?, ?, ?, ?)`,
                [username, hashedPassword, name, 'admin', branch],
                (err) => {
                    if (err) {
                        console.error('Error creating initial admin user:', err.message);
                        rejectAdminBootstrap(err);
                    } else {
                        console.log(`Initial admin user created from environment (username: ${username})`);
                        resolveAdminBootstrap();
                    }
                }
            );
        } else if (row && row.count === 0) {
            console.warn('No users exist. Configure POS_ADMIN_USERNAME and POS_ADMIN_PASSWORD to bootstrap the first admin.');
            resolveAdminBootstrap();
        } else if (row && row.count > 0) {
            const bcrypt = require('bcryptjs');
            db.get('SELECT id, password FROM users WHERE username = ?', ['admin'], (adminError, admin) => {
                if (adminError) {
                    console.error('Default admin safety check error:', adminError.message);
                    rejectAdminBootstrap(adminError);
                    return;
                }
                if (!admin || !bcrypt.compareSync('admin123', admin.password)) {
                    resolveAdminBootstrap();
                    return;
                }

                const replacementPassword = process.env.POS_ADMIN_PASSWORD;
                if (replacementPassword && replacementPassword.length >= 8 && replacementPassword !== 'admin123') {
                    db.run(
                        `UPDATE users SET password = ?, isActive = 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
                        [bcrypt.hashSync(replacementPassword, 12), admin.id],
                        (updateError) => {
                            if (updateError) {
                                console.error('Default admin password rotation failed:', updateError.message);
                                rejectAdminBootstrap(updateError);
                            } else {
                                console.warn('The legacy default admin password was replaced from POS_ADMIN_PASSWORD.');
                                resolveAdminBootstrap();
                            }
                        }
                    );
                } else {
                    // Desktop first-run credentials are intentionally supplied by Electron.
                    // Keep that administrator active so the documented first login works.
                    resolveAdminBootstrap();
                }
            });
        }
    });

    // Seed sample products if none exist
    db.get('SELECT COUNT(*) as count FROM products', (err, row) => {
        if (err) {
            console.error('Product seed check error:', err.message);
            rejectProductSeed(err);
            return;
        }
        if (row && row.count === 0 && process.env.POS_DISABLE_SAMPLE_DATA !== 'true') {
            const sampleProducts = [
                { code: '101', name: 'Iced Coffee Latte', price: 120.00, stock: 50, category: 'Beverages' },
                { code: '102', name: 'Chocolate Muffin', price: 85.00, stock: 30, category: 'Pastries' },
                { code: '103', name: 'Club Sandwich', price: 150.00, stock: 25, category: 'Meals' },
                { code: '104', name: 'Bottled Water', price: 35.00, stock: 100, category: 'Beverages' },
                { code: '105', name: 'Cappuccino', price: 110.00, stock: 45, category: 'Beverages' },
                { code: '106', name: 'Blueberry Cheesecake', price: 120.00, stock: 20, category: 'Pastries' }
            ];

            const stmt = db.prepare(
                `INSERT INTO products (code, name, price, stock, category) 
                 VALUES (?, ?, ?, ?, ?)`
            );

            sampleProducts.forEach(p => {
                stmt.run([p.code, p.name, p.price, p.stock, p.category]);
            });

            stmt.finalize((err) => {
                if (err) {
                    console.error('Error seeding products:', err.message);
                    rejectProductSeed(err);
                } else {
                    console.log('✓ Sample products seeded');
                    resolveProductSeed();
                }
            });
        } else {
            resolveProductSeed();
        }
    });
});

module.exports = db;
