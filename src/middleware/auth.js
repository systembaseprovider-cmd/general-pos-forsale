const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { hasModulePermission } = require('../services/modulePermissions');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 characters before starting the POS server.');
}
const TOKEN_EXPIRY = '24h';

/**
 * Verify JWT token and extract user info
 */
async function verifyToken(req, res, next) {
    const authorization = req.headers.authorization || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
        return res.status(401).json({
            success: false,
            message: 'A bearer token is required'
        });
    }

    let decoded;
    try {
        decoded = jwt.verify(match[1], JWT_SECRET);
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'Invalid or expired token'
        });
    }

    try {
        const user = await User.findById(decoded.id);
        if (!user || decoded.tokenVersion !== user.tokenVersion) {
            return res.status(401).json({
                success: false,
                message: 'User access has changed. Please sign in again.'
            });
        }
        req.user = user;
        return next();
    } catch (error) {
        console.error('Authentication user lookup error:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to verify user access'
        });
    }
}

/**
 * Generate JWT token
 */
function generateToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            name: user.name,
            role: user.role,
            branch: user.branch,
            tokenVersion: user.tokenVersion
        },
        JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY }
    );
}

/**
 * Check if user has required role
 */
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: 'Insufficient permissions'
            });
        }
        next();
    };
}

function requireModule(module) {
    return (req, res, next) => {
        if (!req.user || !hasModulePermission(req.user, module)) {
            return res.status(403).json({
                success: false,
                message: 'Your account does not have access to this module'
            });
        }
        return next();
    };
}

module.exports = {
    verifyToken,
    generateToken,
    requireRole,
    requireModule
};
