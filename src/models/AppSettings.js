const db = require('../database');

const DEFAULT_SETTINGS = Object.freeze({
    appName: 'POS Store',
    logoDataUrl: null,
    address: '',
    tin: '',
    phone: '',
    receiptFooter: 'Thank you for your purchase!'
});

class AppSettings {
    static getPublic() {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT appName, logoDataUrl FROM appSettings WHERE id = 1',
                (error, row) => {
                    if (error) return reject(error);
                    resolve(row || {
                        appName: DEFAULT_SETTINGS.appName,
                        logoDataUrl: DEFAULT_SETTINGS.logoDataUrl
                    });
                }
            );
        });
    }

    static get() {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT appName, logoDataUrl, address, tin, phone, receiptFooter, updatedAt
                 FROM appSettings WHERE id = 1`,
                (error, row) => {
                    if (error) return reject(error);
                    resolve(row || { ...DEFAULT_SETTINGS });
                }
            );
        });
    }

    static async update(updates) {
        const current = await this.get();
        const next = { ...current };
        for (const field of ['appName', 'address', 'tin', 'phone', 'receiptFooter']) {
            if (updates[field] === undefined) continue;
            if (typeof updates[field] !== 'string') {
                throw new Error(`${field} must be text`);
            }
            next[field] = updates[field].trim();
        }

        if (next.appName.length < 2 || next.appName.length > 80) {
            throw new Error('App name must be 2-80 characters');
        }
        if (next.address.length > 300 || next.tin.length > 50 ||
            next.phone.length > 50 || next.receiptFooter.length > 240) {
            throw new Error('Branding or receipt details exceed the allowed length');
        }
        if (updates.logoDataUrl !== undefined) {
            next.logoDataUrl = validateLogo(updates.logoDataUrl);
        }

        return new Promise((resolve, reject) => {
            db.run(
                `UPDATE appSettings
                 SET appName = ?, logoDataUrl = ?, address = ?, tin = ?, phone = ?,
                     receiptFooter = ?, updatedAt = CURRENT_TIMESTAMP
                 WHERE id = 1`,
                [
                    next.appName,
                    next.logoDataUrl,
                    next.address,
                    next.tin,
                    next.phone,
                    next.receiptFooter
                ],
                error => error ? reject(error) : resolve(next)
            );
        });
    }
}

function validateLogo(value) {
    if (value === null || value === '') return null;
    if (typeof value !== 'string') throw new Error('Logo must be a PNG, JPEG, or WebP image');

    const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw new Error('Logo must be a PNG, JPEG, or WebP image');
    const [, mimeType, encoded] = match;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.length > 512 * 1024 || bytes.toString('base64') !== encoded) {
        throw new Error('Logo must be a valid image no larger than 512 KB');
    }

    const isPng = mimeType === 'image/png' &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = mimeType === 'image/jpeg' &&
        bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isWebp = mimeType === 'image/webp' &&
        bytes.toString('ascii', 0, 4) === 'RIFF' &&
        bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!isPng && !isJpeg && !isWebp) throw new Error('Logo file contents do not match a supported image format');
    return value;
}

module.exports = AppSettings;
