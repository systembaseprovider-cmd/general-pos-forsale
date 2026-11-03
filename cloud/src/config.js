const loadEnv = require('../../src/services/loadEnv');

loadEnv();

function requiredSecret(name) {
    const value = process.env[name] || '';
    if (value.length < 32) throw new Error(`${name} must be configured with at least 32 characters.`);
    return value;
}

function getCloudConfig() {
    const mongoUri = process.env.MONGODB_URI || '';
    if (!mongoUri.startsWith('mongodb')) throw new Error('MONGODB_URI must be configured before starting the cloud service.');
    const port = Number(process.env.CLOUD_PORT || 4100);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('CLOUD_PORT must be a valid port number.');
    const offlineLeaseDays = Number(process.env.CLOUD_OFFLINE_LEASE_DAYS || 7);
    if (!Number.isSafeInteger(offlineLeaseDays) || offlineLeaseDays < 1 || offlineLeaseDays > 30) throw new Error('CLOUD_OFFLINE_LEASE_DAYS must be between 1 and 30 days.');
    return { mongoUri, port, offlineLeaseDays, jwtSecret: requiredSecret('CLOUD_JWT_SECRET'), adminKey: requiredSecret('CLOUD_ADMIN_KEY') };
}

module.exports = { getCloudConfig };
