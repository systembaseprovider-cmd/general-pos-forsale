const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
    organizationId: { type: String, required: true, trim: true, index: true },
    storeId: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED', 'REVOKED'], default: 'ACTIVE', index: true },
    activationVersion: { type: Number, default: 1, min: 1 },
    fingerprint: { type: String, trim: true, maxlength: 256 },
    publicKey: { type: String, trim: true, maxlength: 4096 },
    lastSeenAt: Date
}, { timestamps: true });
deviceSchema.index({ organizationId: 1, storeId: 1, name: 1 }, { unique: true });

const activationSchema = new mongoose.Schema({
    organizationId: { type: String, required: true, trim: true, index: true },
    storeId: { type: String, required: true, trim: true, index: true },
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'CloudDevice', required: true, index: true },
    codeHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    usedAt: Date,
    usedByFingerprint: String
}, { timestamps: true });

const syncEventSchema = new mongoose.Schema({
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'CloudDevice', required: true, index: true },
    eventId: { type: String, required: true, trim: true, maxlength: 128 },
    type: { type: String, required: true, trim: true, maxlength: 80 },
    occurredAt: { type: Date, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    receivedAt: { type: Date, default: Date.now }
}, { versionKey: false });
syncEventSchema.index({ deviceId: 1, eventId: 1 }, { unique: true });

module.exports = { Device: mongoose.models.CloudDevice || mongoose.model('CloudDevice', deviceSchema), Activation: mongoose.models.DeviceActivation || mongoose.model('DeviceActivation', activationSchema), SyncEvent: mongoose.models.SyncEvent || mongoose.model('SyncEvent', syncEventSchema) };
