const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'general-pos-password-test-'));
process.env.POS_DB_PATH = path.join(tempDirectory, 'pos.db');
process.env.POS_BACKUP_DIR = path.join(tempDirectory, 'backups');
process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64');

const db = require('../src/database');
const User = require('../src/models/User');
const { generateToken } = require('../src/middleware/auth');

after(async () => {
    await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('password change validates credentials, revokes old tokens, and accepts the new password', async () => {
    await db.ready;
    const user = await User.create('password-change-test', 'old-password-123', 'Password Change Tester');
    const token = generateToken(await User.findById(user.id));
    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../src/routes/auth.routes'));

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });

    try {
        const baseUrl = `http://127.0.0.1:${server.address().port}/api/auth`;
        const changePassword = (currentPin, newPin) => fetch(`${baseUrl}/change-password`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ currentPin, newPin })
        });

        const invalidCurrentPassword = await changePassword('wrong-password', 'new-password-123');
        assert.equal(invalidCurrentPassword.status, 401);

        const tooShortPassword = await changePassword('old-password-123', 'short');
        assert.equal(tooShortPassword.status, 400);

        const changed = await changePassword('old-password-123', 'new-password-123');
        assert.equal(changed.status, 200);
        assert.equal((await changed.json()).success, true);

        const oldTokenResponse = await fetch(`${baseUrl}/verify`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(oldTokenResponse.status, 401);

        const oldPasswordLogin = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user.username, pin: 'old-password-123' })
        });
        assert.equal(oldPasswordLogin.status, 401);

        const newPasswordLogin = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user.username, pin: 'new-password-123' })
        });
        assert.equal(newPasswordLogin.status, 200);
        assert.equal((await newPasswordLogin.json()).success, true);
    } finally {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
});
