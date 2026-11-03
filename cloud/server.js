const mongoose = require('mongoose');
const { getCloudConfig } = require('./src/config');
const { createCloudApp } = require('./src/app');
async function start() {
    const config = getCloudConfig(); await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
    const app = createCloudApp(config); const server = app.listen(config.port, '127.0.0.1', () => console.log(`General POS cloud control service is running at http://127.0.0.1:${config.port}`));
    const stop = async () => server.close(async () => { await mongoose.disconnect(); process.exit(0); });
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
start().catch(error => { console.error('Unable to start the cloud control service:', error.message); process.exit(1); });
