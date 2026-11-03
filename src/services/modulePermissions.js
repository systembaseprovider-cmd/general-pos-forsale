const MODULES = Object.freeze({
    pos: 'POS Sales',
    inventory: 'Inventory',
    products: 'Products List',
    reports: 'Reports'
});

const DEFAULT_CASHIER_PERMISSIONS = Object.freeze({
    pos: true,
    inventory: false,
    products: false,
    reports: true
});

function normalizeModulePermissions(value, defaults = DEFAULT_CASHIER_PERMISSIONS) {
    let input = value;
    if (typeof input === 'string') {
        try {
            input = JSON.parse(input);
        } catch {
            input = {};
        }
    }
    if (input === undefined) input = defaults;
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};

    return Object.fromEntries(
        Object.keys(MODULES).map(module => [module, input?.[module] === true])
    );
}

function hasModulePermission(user, module) {
    if (user?.role === 'admin') return true;
    return Boolean(user && Object.hasOwn(MODULES, module) &&
        normalizeModulePermissions(user.modulePermissions)[module]);
}

function requireModule(module) {
    return requireAnyModule(module);
}

function requireAnyModule(...modules) {
    return (req, res, next) => {
        if (!req.user || !modules.some(module => hasModulePermission(req.user, module))) {
            return res.status(403).json({
                success: false,
                message: 'Your account does not have access to this module'
            });
        }
        return next();
    };
}

module.exports = {
    MODULES,
    DEFAULT_CASHIER_PERMISSIONS,
    normalizeModulePermissions,
    hasModulePermission,
    requireModule,
    requireAnyModule
};
