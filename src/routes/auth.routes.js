const express = require('express');
const User = require('../models/User');
const { generateToken, verifyToken, requireRole } = require('../middleware/auth');
const { DEFAULT_CASHIER_PERMISSIONS } = require('../services/modulePermissions');

const router = express.Router();

/**
 * POST /api/auth/login
 * Authenticate user with username and password
 */
router.post('/login', async (req, res) => {
    try {
        const { username, pin } = req.body;

        // Validate input
        if (!username || !pin) {
            return res.status(400).json({
                success: false,
                message: 'Username and PIN are required'
            });
        }

        // Trim whitespace
        const trimmedUsername = String(username).trim();
        const trimmedPin = String(pin).trim();

        // Find user in database
        const user = await User.findByUsername(trimmedUsername);

        if (!user) {
            // Don't reveal if username exists (security best practice)
            return res.status(401).json({
                success: false,
                message: 'Invalid username or PIN'
            });
        }

        // Verify password (PIN)
        const isPasswordValid = User.verifyPassword(trimmedPin, user.password);

        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid username or PIN'
            });
        }

        // Generate JWT token
        const token = generateToken(user);

        // Return success with user info and token
        return res.status(200).json({
            success: true,
            message: 'Login successful',
            token: token,
            user: {
                id: user.id,
                username: user.username,
                name: user.name,
                role: user.role,
                branch: user.branch,
                modulePermissions: user.modulePermissions
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during login'
        });
    }
});

/**
 * POST /api/auth/verify
 * Verify if current token is valid
 */
router.post('/verify', verifyToken, (req, res) => {
    return res.status(200).json({
        success: true,
        message: 'Token is valid',
        user: req.user
    });
});

/**
 * POST /api/auth/refresh
 * Generate new token (optional - for token refresh)
 */
router.post('/refresh', verifyToken, (req, res) => {
    const newToken = generateToken(req.user);
    return res.status(200).json({
        success: true,
        message: 'Token refreshed',
        token: newToken,
        user: req.user
    });
});

router.post('/change-password', verifyToken, async (req, res) => {
    try {
        const { currentPin, newPin } = req.body || {};
        if (typeof currentPin !== 'string' || typeof newPin !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'Current and new password/PIN are required'
            });
        }

        const user = await User.findByUsername(req.user.username);
        if (!user || !User.verifyPassword(currentPin, user.password)) {
            return res.status(401).json({
                success: false,
                message: 'Current password/PIN is incorrect'
            });
        }

        await User.updatePassword(req.user.id, newPin);
        return res.status(200).json({
            success: true,
            message: 'Password/PIN changed. Please sign in again.'
        });
    } catch (error) {
        console.error('Change password error:', error);
        return res.status(400).json({
            success: false,
            message: error.message || 'Unable to change password/PIN'
        });
    }
});

router.get('/users', verifyToken, requireRole('admin'), async (req, res) => {
    try {
        const users = await User.listByBranch(req.user.branch);
        return res.status(200).json({ success: true, data: users, count: users.length });
    } catch (error) {
        console.error('List users error:', error);
        return res.status(500).json({ success: false, message: 'Unable to load users' });
    }
});

router.post('/users', verifyToken, requireRole('admin'), async (req, res) => {
    try {
        const {
            username,
            pin,
            name,
            role = 'cashier',
            branch,
            modulePermissions = DEFAULT_CASHIER_PERMISSIONS
        } = req.body || {};
        if (!['admin', 'cashier'].includes(role)) {
            return res.status(400).json({
                success: false,
                message: 'Role must be admin or cashier'
            });
        }
        const userBranch = String(branch || req.user.branch).trim();
        if (userBranch !== req.user.branch) {
            return res.status(403).json({
                success: false,
                message: 'Admins may create users only for their own branch'
            });
        }

        const user = await User.create(
            String(username || '').trim(),
            pin,
            String(name || '').trim(),
            role,
            userBranch,
            modulePermissions,
            req.user
        );
        return res.status(201).json({
            success: true,
            message: 'User created successfully',
            data: user
        });
    } catch (error) {
        console.error('Create user error:', error);
        return res.status(400).json({
            success: false,
            message: error.message || 'Unable to create user'
        });
    }
});

router.put('/users/:id', verifyToken, requireRole('admin'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid user ID' });
        }
        const existing = (await User.listByBranch(req.user.branch)).find(user => user.id === id);
        if (!existing) {
            return res.status(404).json({ success: false, message: 'User not found in this branch' });
        }
        const body = req.body || {};
        const user = await User.updateManaged({
            id,
            branch: req.user.branch,
            actorId: req.user.id,
            name: body.name === undefined ? existing.name : body.name,
            username: body.username === undefined ? existing.username : body.username,
            role: body.role === undefined ? existing.role : body.role,
            password: body.password,
            modulePermissions: body.modulePermissions === undefined
                ? existing.modulePermissions
                : body.modulePermissions,
            isActive: body.isActive === undefined ? existing.isActive : body.isActive
        });
        return res.status(200).json({
            success: true,
            message: 'User updated successfully',
            data: user
        });
    } catch (error) {
        console.error('Update user error:', error);
        const status = /not found/i.test(error.message) ? 404 : /already exists|last active administrator|own administrator/i.test(error.message) ? 409 : 400;
        return res.status(status).json({
            success: false,
            message: error.message || 'Unable to update user'
        });
    }
});

router.delete('/users/:id', verifyToken, requireRole('admin'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid user ID' });
        }
        const existing = (await User.listByBranch(req.user.branch)).find(user => user.id === id);
        if (!existing) {
            return res.status(404).json({ success: false, message: 'User not found in this branch' });
        }
        const user = await User.updateManaged({
            id,
            branch: req.user.branch,
            actorId: req.user.id,
            name: existing.name,
            username: existing.username,
            role: existing.role,
            modulePermissions: existing.modulePermissions,
            isActive: false
        });
        return res.status(200).json({ success: true, message: 'User disabled successfully', data: user });
    } catch (error) {
        console.error('Disable user error:', error);
        const status = /not found/i.test(error.message) ? 404 : /last active administrator|own administrator/i.test(error.message) ? 409 : 400;
        return res.status(status).json({
            success: false,
            message: error.message || 'Unable to disable user'
        });
    }
});

module.exports = router;
