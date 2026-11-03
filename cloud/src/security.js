const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function hashSecret(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function createActivationCode() { return crypto.randomBytes(18).toString('base64url'); }
function safeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left || ''), 'utf8');
    const rightBuffer = Buffer.from(String(right || ''), 'utf8');
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
function createDeviceToken(device, jwtSecret, offlineLeaseDays) {
    return jwt.sign({ kind: 'pos-device', deviceId: String(device._id), activationVersion: device.activationVersion, organizationId: device.organizationId, storeId: device.storeId, offlineUntil: new Date(Date.now() + (offlineLeaseDays * 86400000)).toISOString() }, jwtSecret, { expiresIn: `${offlineLeaseDays}d`, issuer: 'general-pos-cloud', audience: 'general-pos-device' });
}
function readDeviceToken(token, jwtSecret) { return jwt.verify(token, jwtSecret, { issuer: 'general-pos-cloud', audience: 'general-pos-device' }); }

module.exports = { hashSecret, createActivationCode, safeEqual, createDeviceToken, readDeviceToken };
