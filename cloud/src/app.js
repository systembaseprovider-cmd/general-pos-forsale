const express = require('express');
const mongoose = require('mongoose');
const { Device, Activation, SyncEvent } = require('./models');
const { hashSecret, createActivationCode, safeEqual, createDeviceToken, readDeviceToken } = require('./security');
const MAX_SYNC_EVENTS = 100;
const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
function asTrimmedString(value, maximumLength) { return typeof value === 'string' ? value.trim().slice(0, maximumLength) : ''; }
function cloudAdmin(config) { return (req, res, next) => safeEqual(req.get('x-cloud-admin-key'), config.adminKey) ? next() : res.status(401).json({ success: false, message: 'Cloud administrator authorization is required.' }); }
function deviceAuth(config) { return async (req, res, next) => {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ success: false, message: 'Device bearer token is required.' });
    try {
        const claims = readDeviceToken(match[1], config.jwtSecret);
        if (claims.kind !== 'pos-device') throw new Error('Invalid device token.');
        const device = await Device.findById(claims.deviceId).lean();
        if (!device || device.status !== 'ACTIVE' || device.activationVersion !== claims.activationVersion) return res.status(403).json({ success: false, message: 'This device is no longer active.' });
        req.device = device;
        return next();
    } catch (_error) { return res.status(401).json({ success: false, message: 'Invalid or expired device token.' }); }
}; }
function createCloudApp(config) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.get('/health', (_req, res) => res.json({ success: true, service: 'general-pos-cloud-control' }));
    app.post('/admin/devices', cloudAdmin(config), async (req, res, next) => {
        try {
            const organizationId = asTrimmedString(req.body.organizationId, 80); const storeId = asTrimmedString(req.body.storeId, 80); const name = asTrimmedString(req.body.name, 120); const expiresInMinutes = Number(req.body.expiresInMinutes || 30);
            if (!organizationId || !storeId || !name || !Number.isSafeInteger(expiresInMinutes) || expiresInMinutes < 5 || expiresInMinutes > 1440) return res.status(400).json({ success: false, message: 'Organization, store, device name, or activation lifetime is invalid.' });
            const device = await Device.create({ organizationId, storeId, name }); const activationCode = createActivationCode(); const expiresAt = new Date(Date.now() + (expiresInMinutes * 60000));
            await Activation.create({ organizationId, storeId, deviceId: device._id, codeHash: hashSecret(activationCode), expiresAt });
            return res.status(201).json({ success: true, data: { deviceId: device.id, activationCode, expiresAt } });
        } catch (error) { return next(error); }
    });
    app.post('/devices/activate', async (req, res, next) => {
        try {
            const code = asTrimmedString(req.body.activationCode, 200); const fingerprint = asTrimmedString(req.body.fingerprint, 256); const publicKey = asTrimmedString(req.body.publicKey, 4096);
            if (!code || !fingerprint || !publicKey) return res.status(400).json({ success: false, message: 'Activation code, device fingerprint, and device public key are required.' });
            const activation = await Activation.findOne({ codeHash: hashSecret(code), usedAt: null, expiresAt: { $gt: new Date() } });
            if (!activation) return res.status(400).json({ success: false, message: 'Activation code is invalid, used, or expired.' });
            const device = await Device.findById(activation.deviceId);
            if (!device || device.status !== 'ACTIVE') return res.status(403).json({ success: false, message: 'This device cannot be activated.' });
            device.fingerprint = fingerprint; device.publicKey = publicKey; device.lastSeenAt = new Date(); await device.save(); activation.usedAt = new Date(); activation.usedByFingerprint = fingerprint; await activation.save();
            return res.status(200).json({ success: true, data: { deviceId: device.id, deviceToken: createDeviceToken(device, config.jwtSecret, config.offlineLeaseDays), offlineLeaseDays: config.offlineLeaseDays } });
        } catch (error) { return next(error); }
    });
    app.get('/devices/me/policy', deviceAuth(config), async (req, res, next) => {
        try { await Device.updateOne({ _id: req.device._id }, { $set: { lastSeenAt: new Date() } }); return res.json({ success: true, data: { deviceId: String(req.device._id), organizationId: req.device.organizationId, storeId: req.device.storeId, status: req.device.status, offlineLeaseDays: config.offlineLeaseDays } }); } catch (error) { return next(error); }
    });
    app.post('/sync/events', deviceAuth(config), async (req, res, next) => {
        try {
            const events = Array.isArray(req.body.events) ? req.body.events : [];
            if (events.length < 1 || events.length > MAX_SYNC_EVENTS) return res.status(400).json({ success: false, message: `Send between 1 and ${MAX_SYNC_EVENTS} events per request.` });
            const now = new Date(); const writes = [];
            for (const event of events) {
                if (!event || !EVENT_ID_PATTERN.test(String(event.eventId || '')) || !asTrimmedString(event.type, 80) || !event.occurredAt || typeof event.payload !== 'object' || event.payload === null) return res.status(400).json({ success: false, message: 'One or more sync events are invalid.' });
                const occurredAt = new Date(event.occurredAt); if (Number.isNaN(occurredAt.getTime())) return res.status(400).json({ success: false, message: 'One or more event dates are invalid.' });
                writes.push({ updateOne: { filter: { deviceId: req.device._id, eventId: String(event.eventId) }, update: { $setOnInsert: { deviceId: req.device._id, eventId: String(event.eventId), type: asTrimmedString(event.type, 80), occurredAt, payload: event.payload, receivedAt: now } }, upsert: true } });
            }
            const result = await SyncEvent.bulkWrite(writes, { ordered: false }); await Device.updateOne({ _id: req.device._id }, { $set: { lastSeenAt: now } });
            return res.json({ success: true, data: { received: events.length, accepted: result.upsertedCount || 0, duplicates: events.length - (result.upsertedCount || 0) } });
        } catch (error) { return next(error); }
    });
    app.use((error, _req, res, _next) => {
        if (error instanceof mongoose.Error.ValidationError || error?.code === 11000) return res.status(400).json({ success: false, message: 'Cloud data is invalid or already exists.' });
        console.error('Cloud control service error:', error); return res.status(500).json({ success: false, message: 'Cloud control service error.' });
    });
    return app;
}
module.exports = { createCloudApp };
