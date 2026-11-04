const BUSINESS_TIME_ZONE = 'Asia/Manila';

function getBusinessDate(date = new Date()) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        throw new Error('A valid date is required');
    }

    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: BUSINESS_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function isValidBusinessDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

module.exports = {
    BUSINESS_TIME_ZONE,
    getBusinessDate,
    isValidBusinessDate
};
