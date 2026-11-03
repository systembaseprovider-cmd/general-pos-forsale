const fs = require('fs');
const path = require('path');

function loadEnv() {
    const envPath = path.join(__dirname, '..', '..', '.env');
    if (!fs.existsSync(envPath)) return;

    if (typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(envPath);
        return;
    }

    const contents = fs.readFileSync(envPath, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
        const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
        process.env[match[1]] = value;
    }
}

module.exports = loadEnv;
