const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

function openDatabase(filePath, mode = sqlite3.OPEN_READWRITE) {
    return new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(filePath, mode, error => {
            if (error) reject(error);
            else resolve(connection);
        });
    });
}

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
            if (error) reject(error);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

function close(connection) {
    return new Promise((resolve, reject) => {
        connection.close(error => error ? reject(error) : resolve());
    });
}

function hashFile(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createVerifiedBackup(filePath, suffix) {
    const backupDirectory = path.join(path.dirname(filePath), 'backups');
    fs.mkdirSync(backupDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDirectory, `pre-sales-import-${suffix}-${timestamp}.db`);
    fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    if (hashFile(filePath) !== hashFile(backupPath)) {
        throw new Error(`Backup verification failed for ${filePath}`);
    }
    return backupPath;
}

function assertNoActiveSidecars(filePath) {
    for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${filePath}${suffix}`;
        if (fs.existsSync(sidecar) && fs.statSync(sidecar).size > 0) {
            throw new Error(`SQLite sidecar ${sidecar} is not empty. Close the POS app before importing.`);
        }
    }
}

async function assertHealthy(connection, label) {
    const integrity = await all(connection, 'PRAGMA integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
        throw new Error(`${label} database failed SQLite integrity_check`);
    }
    const violations = await all(connection, 'PRAGMA foreign_key_check');
    if (violations.length) {
        throw new Error(`${label} database contains foreign-key violations`);
    }
}

async function assertColumns(connection, table, requiredColumns) {
    const columns = new Set((await all(connection, `PRAGMA table_info("${table}")`)).map(row => row.name));
    const missing = requiredColumns.filter(column => !columns.has(column));
    if (missing.length) {
        throw new Error(`${table} is missing required columns: ${missing.join(', ')}`);
    }
}

function sequenceParts(txnNo) {
    const match = /^(.+-\d{4}-)(\d{5})$/.exec(txnNo);
    return match ? { prefix: match[1], sequence: Number(match[2]) } : null;
}

function parseArguments(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--apply') {
            options.apply = true;
        } else if (argument === '--source' || argument === '--target') {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) throw new Error(`${argument} requires a file path`);
            options[argument.slice(2)] = path.resolve(value);
            index++;
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if (!options.source || !options.target || !options.apply) {
        throw new Error('Usage: node scripts/merge-sales.js --source <old-pos.db> --target <installed-pos.db> --apply');
    }
    if (options.source.toLowerCase() === options.target.toLowerCase()) {
        throw new Error('Source and target must be different database files');
    }
    return options;
}

async function mergeSales(sourcePath, targetPath) {
    if (!fs.existsSync(sourcePath) || !fs.existsSync(targetPath)) {
        throw new Error('Both source and installed POS database files must exist');
    }
    assertNoActiveSidecars(sourcePath);
    assertNoActiveSidecars(targetPath);

    const sourceFingerprint = hashFile(sourcePath);
    const sourceBackup = createVerifiedBackup(sourcePath, 'source');
    const targetBackup = createVerifiedBackup(targetPath, 'installed');
    console.log(`Verified source backup: ${sourceBackup}`);
    console.log(`Verified installed backup: ${targetBackup}`);

    const source = await openDatabase(sourcePath, sqlite3.OPEN_READONLY);
    const target = await openDatabase(targetPath);
    let transactionStarted = false;
    let transactionFinished = false;

    try {
        await run(target, 'PRAGMA foreign_keys = ON');
        await assertHealthy(source, 'Source');
        await assertHealthy(target, 'Installed');
        await assertColumns(source, 'users', ['id', 'username', 'name', 'role', 'branch']);
        await assertColumns(target, 'users', ['id', 'username', 'name', 'role', 'branch']);
        await assertColumns(source, 'products', ['id', 'code', 'sku', 'name', 'price', 'uom', 'reorderLevel']);
        await assertColumns(target, 'products', ['id', 'code', 'sku', 'name', 'price', 'stock', 'uom', 'reorderLevel']);
        await assertColumns(source, 'transactions', [
            'id', 'txnNo', 'userId', 'cashierName', 'customerName', 'subtotal',
            'discountAmount', 'vatableSales', 'vatAmount', 'totalAmount',
            'paymentMethod', 'tenderedAmount', 'changeAmount', 'branch',
            'requestHash', 'voidedAt', 'voidReason', 'voidedBy',
            'voidRequestId', 'voidRequestHash', 'referenceNo', 'notes',
            'createdAt', 'updatedAt'
        ]);
        await assertColumns(target, 'transactions', [
            'id', 'txnNo', 'userId', 'cashierName', 'customerName', 'subtotal',
            'discountAmount', 'vatableSales', 'vatAmount', 'totalAmount',
            'paymentMethod', 'tenderedAmount', 'changeAmount', 'branch',
            'requestHash', 'voidedAt', 'voidReason', 'voidedBy',
            'voidRequestId', 'voidRequestHash', 'referenceNo', 'notes',
            'createdAt', 'updatedAt'
        ]);

        const sourceTransactions = await all(source, 'SELECT * FROM transactions ORDER BY id');
        const sourceItems = await all(source, 'SELECT * FROM transactionItems ORDER BY id');
        const sourceRefundCount = (await get(source, 'SELECT COUNT(*) AS count FROM refunds')).count;
        const sourceRefundItemCount = (await get(source, 'SELECT COUNT(*) AS count FROM refundItems')).count;
        const sourceVoidedCount = (await get(source, 'SELECT COUNT(*) AS count FROM transactions WHERE voidedAt IS NOT NULL')).count;
        if (!sourceTransactions.length) throw new Error('The source database has no sales to import');
        if (sourceRefundCount || sourceRefundItemCount || sourceVoidedCount) {
            throw new Error('Source refunds or voided sales were found; import stopped to avoid partial history migration');
        }

        const transactionIds = new Set(sourceTransactions.map(transaction => transaction.id));
        const itemsByTransaction = new Map();
        for (const item of sourceItems) {
            if (!transactionIds.has(item.transactionId)) {
                throw new Error(`Source line item ${item.id} refers to a missing transaction`);
            }
            const items = itemsByTransaction.get(item.transactionId) || [];
            items.push(item);
            itemsByTransaction.set(item.transactionId, items);
        }
        for (const transaction of sourceTransactions) {
            if (!itemsByTransaction.get(transaction.id)?.length) {
                throw new Error(`Source transaction ${transaction.txnNo} has no line items`);
            }
        }

        await run(target, 'BEGIN IMMEDIATE TRANSACTION');
        transactionStarted = true;
        await run(target, `
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
        `);

        const existingByPath = await all(
            target,
            'SELECT DISTINCT sourceFingerprint FROM legacyTransactionImports WHERE sourcePath = ?',
            [sourcePath]
        );
        if (existingByPath.length) {
            if (existingByPath.length === 1 && existingByPath[0].sourceFingerprint === sourceFingerprint) {
                const importedCount = (await get(
                    target,
                    'SELECT COUNT(*) AS count FROM legacyTransactionImports WHERE sourcePath = ? AND sourceFingerprint = ?',
                    [sourcePath, sourceFingerprint]
                )).count;
                if (importedCount === sourceTransactions.length) {
                    await run(target, 'ROLLBACK');
                    transactionFinished = true;
                    console.log(`This source database was already imported (${importedCount} sales); no changes made.`);
                    return { alreadyImported: true };
                }
            }
            throw new Error('This source database path was previously imported; refusing to import it again');
        }
        const existingFingerprint = await get(
            target,
            'SELECT sourcePath FROM legacyTransactionImports WHERE sourceFingerprint = ? LIMIT 1',
            [sourceFingerprint]
        );
        if (existingFingerprint) {
            throw new Error(`Identical source database was already imported from ${existingFingerprint.sourcePath}`);
        }

        const originalTransactions = await all(
            target,
            'SELECT id, txnNo, totalAmount, createdAt FROM transactions ORDER BY id'
        );
        const originalProducts = await all(
            target,
            'SELECT id, code, stock, isActive FROM products ORDER BY id'
        );
        const targetGrossBefore = Number((await get(
            target,
            'SELECT COALESCE(SUM(totalAmount), 0) AS total FROM transactions'
        )).total);
        const targetNetBefore = Number((await get(
            target,
            `SELECT COALESCE(SUM(totalAmount - COALESCE(
                (SELECT SUM(refundAmount) FROM refunds WHERE refunds.transactionId = transactions.id), 0
             )), 0) AS total
             FROM transactions WHERE voidedAt IS NULL`
        )).total);
        const targetItemsBefore = (await get(target, 'SELECT COUNT(*) AS count FROM transactionItems')).count;

        const sourceUsers = await all(source, 'SELECT * FROM users ORDER BY id');
        const targetUsers = await all(target, 'SELECT id, username, role, branch FROM users');
        const userIdMap = new Map();
        for (const sourceUser of sourceUsers) {
            const matchingUser = targetUsers.find(user =>
                user.username === sourceUser.username &&
                user.branch === sourceUser.branch &&
                user.role === sourceUser.role
            );
            if (matchingUser) {
                userIdMap.set(sourceUser.id, matchingUser.id);
                continue;
            }

            const username = `legacy_${sourceFingerprint.slice(0, 12)}_${sourceUser.id}`;
            const password = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
            const archivedUser = await run(
                target,
                `INSERT INTO users (
                    username, password, name, role, branch, isActive,
                    tokenVersion, modulePermissions, createdAt, updatedAt
                 ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
                [
                    username,
                    password,
                    sourceUser.name,
                    sourceUser.role === 'admin' ? 'admin' : 'cashier',
                    sourceUser.branch || '01',
                    '{"pos":false,"inventory":false,"products":false,"reports":false}',
                    sourceUser.createdAt || null,
                    sourceUser.updatedAt || null
                ]
            );
            userIdMap.set(sourceUser.id, archivedUser.id);
        }

        const sourceProducts = await all(source, 'SELECT * FROM products ORDER BY id');
        const targetProducts = await all(target, 'SELECT id, code, sku FROM products');
        const productIdMap = new Map();
        for (const sourceProduct of sourceProducts) {
            let matchingProduct = targetProducts.find(product => product.code === sourceProduct.code);
            if (!matchingProduct && sourceProduct.sku) {
                matchingProduct = targetProducts.find(product => product.sku === sourceProduct.sku);
            }
            if (matchingProduct) {
                productIdMap.set(sourceProduct.id, matchingProduct.id);
                continue;
            }

            const archivedProduct = await run(
                target,
                `INSERT INTO products (
                    code, sku, name, price, stock, uom, reorderLevel,
                    category, description, isActive, createdAt, updatedAt
                 ) VALUES (?, NULL, ?, ?, 0, ?, ?, ?, ?, 0, ?, ?)`,
                [
                    sourceProduct.code,
                    sourceProduct.name,
                    sourceProduct.price,
                    sourceProduct.uom || 'pcs',
                    sourceProduct.reorderLevel || 0,
                    sourceProduct.category || 'General',
                    sourceProduct.description,
                    sourceProduct.createdAt || null,
                    sourceProduct.updatedAt || null
                ]
            );
            productIdMap.set(sourceProduct.id, archivedProduct.id);
        }

        const targetTransactions = await all(target, 'SELECT txnNo FROM transactions');
        const transactionNumbers = new Set(targetTransactions.map(transaction => transaction.txnNo));
        const maxSequences = new Map();
        for (const transaction of [...targetTransactions, ...sourceTransactions]) {
            const parts = sequenceParts(transaction.txnNo);
            if (parts) {
                maxSequences.set(parts.prefix, Math.max(maxSequences.get(parts.prefix) || 0, parts.sequence));
            }
        }
        const transactionNumberMap = new Map();
        for (const transaction of sourceTransactions) {
            let importedTxnNo = transaction.txnNo;
            if (transactionNumbers.has(importedTxnNo)) {
                const parts = sequenceParts(importedTxnNo);
                if (!parts) throw new Error(`Cannot safely assign a unique number for ${transaction.txnNo}`);
                let sequence = (maxSequences.get(parts.prefix) || 0) + 1;
                do {
                    if (sequence > 99999) {
                        throw new Error(`Transaction number sequence is exhausted for ${parts.prefix}`);
                    }
                    importedTxnNo = `${parts.prefix}${String(sequence).padStart(5, '0')}`;
                    sequence++;
                } while (transactionNumbers.has(importedTxnNo));
                maxSequences.set(parts.prefix, sequence - 1);
            }
            transactionNumbers.add(importedTxnNo);
            transactionNumberMap.set(transaction.id, importedTxnNo);
        }

        for (const transaction of sourceTransactions) {
            const importedTxnNo = transactionNumberMap.get(transaction.id);
            const mappedUserId = userIdMap.get(transaction.userId);
            if (!mappedUserId) throw new Error(`No destination user mapping for transaction ${transaction.txnNo}`);
            const inserted = await run(
                target,
                `INSERT INTO transactions (
                    txnNo, userId, cashierName, customerName, subtotal,
                    discountAmount, vatableSales, vatAmount, totalAmount,
                    paymentMethod, tenderedAmount, changeAmount, branch,
                    requestHash, voidedAt, voidReason, voidedBy,
                    voidRequestId, voidRequestHash, referenceNo, notes,
                    createdAt, updatedAt
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    importedTxnNo,
                    mappedUserId,
                    transaction.cashierName,
                    transaction.customerName,
                    transaction.subtotal,
                    transaction.discountAmount,
                    transaction.vatableSales,
                    transaction.vatAmount,
                    transaction.totalAmount,
                    transaction.paymentMethod,
                    transaction.tenderedAmount,
                    transaction.changeAmount,
                    transaction.branch,
                    transaction.requestHash,
                    transaction.voidedAt,
                    transaction.voidReason,
                    transaction.voidedBy == null ? null : userIdMap.get(transaction.voidedBy),
                    transaction.voidRequestId,
                    transaction.voidRequestHash,
                    transaction.referenceNo,
                    transaction.notes,
                    transaction.createdAt,
                    transaction.updatedAt
                ]
            );
            await run(
                target,
                `INSERT INTO legacyTransactionImports (
                    sourceFingerprint, sourcePath, sourceTransactionId,
                    targetTransactionId, originalTxnNo, importedTxnNo
                 ) VALUES (?, ?, ?, ?, ?, ?)`,
                [sourceFingerprint, sourcePath, transaction.id, inserted.id, transaction.txnNo, importedTxnNo]
            );

            for (const item of itemsByTransaction.get(transaction.id)) {
                const mappedProductId = productIdMap.get(item.productId);
                if (!mappedProductId) {
                    throw new Error(`No destination product mapping for source product ${item.productId}`);
                }
                await run(
                    target,
                    `INSERT INTO transactionItems (
                        transactionId, productId, productCode, productName,
                        unitPrice, quantity, lineTotal, createdAt
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        inserted.id,
                        mappedProductId,
                        item.productCode,
                        item.productName,
                        item.unitPrice,
                        item.quantity,
                        item.lineTotal,
                        item.createdAt
                    ]
                );
            }
        }

        const transactionCount = (await get(target, 'SELECT COUNT(*) AS count FROM transactions')).count;
        const itemCount = (await get(target, 'SELECT COUNT(*) AS count FROM transactionItems')).count;
        const importedCount = (await get(
            target,
            'SELECT COUNT(*) AS count FROM legacyTransactionImports WHERE sourcePath = ? AND sourceFingerprint = ?',
            [sourcePath, sourceFingerprint]
        )).count;
        const targetGrossAfter = Number((await get(
            target,
            'SELECT COALESCE(SUM(totalAmount), 0) AS total FROM transactions'
        )).total);
        const targetNetAfter = Number((await get(
            target,
            `SELECT COALESCE(SUM(totalAmount - COALESCE(
                (SELECT SUM(refundAmount) FROM refunds WHERE refunds.transactionId = transactions.id), 0
             )), 0) AS total
             FROM transactions WHERE voidedAt IS NULL`
        )).total);
        const sourceGross = sourceTransactions.reduce((sum, transaction) => sum + Number(transaction.totalAmount), 0);
        const sourceItemCount = sourceItems.length;
        const productSnapshotAfter = await all(
            target,
            'SELECT id, code, stock, isActive FROM products WHERE id <= ? ORDER BY id',
            [originalProducts.length ? Math.max(...originalProducts.map(product => product.id)) : 0]
        );
        const originalTransactionsAfter = await all(
            target,
            'SELECT id, txnNo, totalAmount, createdAt FROM transactions WHERE id <= ? ORDER BY id',
            [originalTransactions.length ? Math.max(...originalTransactions.map(transaction => transaction.id)) : 0]
        );

        if (transactionCount !== originalTransactions.length + sourceTransactions.length ||
            itemCount !== targetItemsBefore + sourceItemCount ||
            importedCount !== sourceTransactions.length) {
            throw new Error('Post-import row counts do not match the source database');
        }
        if (Math.abs(targetGrossAfter - targetGrossBefore - sourceGross) > 0.01 ||
            Math.abs(targetNetAfter - targetNetBefore - sourceGross) > 0.01) {
            throw new Error('Post-import sales totals do not match the source database');
        }
        if (JSON.stringify(productSnapshotAfter) !== JSON.stringify(originalProducts) ||
            JSON.stringify(originalTransactionsAfter) !== JSON.stringify(originalTransactions)) {
            throw new Error('Existing installed products or sales changed during import');
        }
        await assertHealthy(target, 'Merged');

        await run(target, 'COMMIT');
        transactionFinished = true;
        console.log(`Imported ${sourceTransactions.length} transactions and ${sourceItemCount} line items.`);
        console.log(`Destination totals: ${transactionCount} transactions, ${itemCount} line items.`);
        console.log(`Source gross sales: ${sourceGross.toFixed(2)}; installed gross sales: ${targetGrossAfter.toFixed(2)}.`);
        console.log(`Refund-adjusted sales total: ${targetNetAfter.toFixed(2)}.`);
        console.log(`Renumbered collisions: ${[...transactionNumberMap].filter(([id, txnNo]) =>
            sourceTransactions.find(transaction => transaction.id === id)?.txnNo !== txnNo
        ).length}. Original numbers are retained in legacyTransactionImports.`);
    } catch (error) {
        if (transactionStarted && !transactionFinished) {
            try {
                await run(target, 'ROLLBACK');
                transactionFinished = true;
            } catch (rollbackError) {
                console.error('Sales import rollback failed:', rollbackError);
                error.message = `${error.message}; rollback failed: ${rollbackError.message}`;
            }
        }
        throw error;
    } finally {
        await Promise.all([close(source), close(target)]);
    }
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    await mergeSales(options.source, options.target);
}

main().catch(error => {
    console.error(`Sales import failed: ${error.message}`);
    process.exitCode = 1;
});
