const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'general-pos-first-run-admin-test-'));
process.env.POS_DB_PATH = path.join(tempDirectory, 'pos.db');
process.env.POS_BACKUP_DIR = path.join(tempDirectory, 'backups');
process.env.POS_ADMIN_USERNAME = 'admin';
process.env.POS_ADMIN_PASSWORD = 'admin123';
process.env.POS_ADMIN_NAME = 'Administrator';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64');

const db = require('../src/database');
const User = require('../src/models/User');

after(async () => {
    await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('Electron first-run administrator remains active with the documented credentials', async () => {
    await db.ready;

    const admin = await User.findByUsername('admin');
    assert.ok(admin, 'the first-run administrator must be active');
    assert.equal(admin.role, 'admin');
    assert.equal(User.verifyPassword('admin123', admin.password), true);
});
