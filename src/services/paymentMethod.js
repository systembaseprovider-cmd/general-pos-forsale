const SUPPORTED_PAYMENT_METHODS = new Set(['CASH', 'CARD', 'BANK', 'E-WALLET']);

function normalizePaymentMethod(method) {
    if (typeof method !== 'string') return null;
    const normalizedMethod = method.trim().toUpperCase();
    return SUPPORTED_PAYMENT_METHODS.has(normalizedMethod) ? normalizedMethod : null;
}

module.exports = {
    normalizePaymentMethod
};
