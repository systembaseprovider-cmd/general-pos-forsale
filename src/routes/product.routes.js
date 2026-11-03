const express = require('express');
const Product = require('../models/Product');
const { verifyToken } = require('../middleware/auth');
const { requireModule, requireAnyModule } = require('../services/modulePermissions');

const router = express.Router();
router.use(verifyToken);

// ========================================
// PUBLIC ROUTES (Accessible to all users)
// ========================================

/**
 * GET /api/products
 * Get all active products
 */
router.get('/', requireAnyModule('pos', 'inventory', 'products'), async (req, res) => {
    try {
        const products = await Product.getAll();
        return res.status(200).json({
            success: true,
            data: products,
            count: products.length
        });
    } catch (error) {
        console.error('Get products error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching products'
        });
    }
});

/**
 * GET /api/products/search?q=term
 * Search products by name, code, or category
 */
router.get('/search', requireAnyModule('pos', 'inventory', 'products'), async (req, res) => {
    try {
        const { q } = req.query;

        if (!q || q.trim().length < 1) {
            return res.status(400).json({
                success: false,
                message: 'Search term is required'
            });
        }

        const results = await Product.search(q.trim());
        return res.status(200).json({
            success: true,
            data: results,
            count: results.length
        });
    } catch (error) {
        console.error('Search products error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error searching products'
        });
    }
});

/**
 * GET /api/products/code/:code
 * Get product by barcode code
 */
router.get('/code/:code', requireAnyModule('pos', 'inventory', 'products'), async (req, res) => {
    try {
        const { code } = req.params;

        if (!code || code.trim().length < 1) {
            return res.status(400).json({
                success: false,
                message: 'Product code is required'
            });
        }

        const product = await Product.getByCode(code.trim());

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        return res.status(200).json({
            success: true,
            data: product
        });
    } catch (error) {
        console.error('Get product by code error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching product'
        });
    }
});

/**
 * GET /api/products/category/:category
 * Get products by category
 */
router.get('/category/:category', requireAnyModule('pos', 'inventory', 'products'), async (req, res) => {
    try {
        const { category } = req.params;

        if (!category || category.trim().length < 1) {
            return res.status(400).json({
                success: false,
                message: 'Category is required'
            });
        }

        const products = await Product.getByCategory(category.trim());
        return res.status(200).json({
            success: true,
            data: products,
            count: products.length
        });
    } catch (error) {
        console.error('Get products by category error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching products'
        });
    }
});

/**
 * GET /api/products/low-stock?threshold=10
 * Get low stock products
 */
router.get('/low-stock', requireModule('inventory'), async (req, res) => {
    try {
        const { threshold } = req.query;
        const thresholdValue = threshold === undefined ? 10 : Number(threshold);

        if (!Number.isSafeInteger(thresholdValue) || thresholdValue < 0) {
            return res.status(400).json({
                success: false,
                message: 'Threshold must be a non-negative number'
            });
        }

        const products = await Product.getLowStock(thresholdValue);
        return res.status(200).json({
            success: true,
            data: products,
            count: products.length
        });
    } catch (error) {
        console.error('Get low stock error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching low stock products'
        });
    }
});

router.get('/movements', requireModule('inventory'), async (req, res) => {
    try {
        const productId = req.query.productId === undefined ? undefined : Number(req.query.productId);
        const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
        const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
        if ((productId !== undefined && (!Number.isSafeInteger(productId) || productId <= 0)) ||
            !Number.isInteger(limit) || limit < 1 || limit > 500 ||
            !Number.isInteger(offset) || offset < 0) {
            return res.status(400).json({
                success: false,
                message: 'Product ID, limit, or offset is invalid'
            });
        }

        const movements = await Product.getMovements({
            branch: req.user.branch,
            productId,
            limit,
            offset
        });
        return res.status(200).json({
            success: true,
            data: movements,
            count: movements.length
        });
    } catch (error) {
        console.error('Get inventory movements error:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to load inventory movements'
        });
    }
});

/**
 * GET /api/products/:id
 * Keep this generic route after all named product routes.
 */
router.get('/:id', requireAnyModule('pos', 'inventory', 'products'), async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid product ID'
            });
        }

        const product = await Product.getById(parseInt(id, 10));

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        return res.status(200).json({
            success: true,
            data: product
        });
    } catch (error) {
        console.error('Get product error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching product'
        });
    }
});

// ========================================
// ADMIN ROUTES (Protected)
// ========================================

/**
 * POST /api/products
 * Create new product (Admin only)
 */
router.post('/', requireModule('products'), async (req, res) => {
    try {
        const { code, sku, name, price, stock, initialQty, reorderLevel, uom, category, description } = req.body || {};
        const openingQuantity = initialQty === undefined ? (stock === undefined ? 0 : stock) : initialQty;

        const product = await Product.create({
            code,
            sku,
            name,
            price,
            initialQty: openingQuantity,
            reorderLevel: reorderLevel === undefined ? 0 : reorderLevel,
            uom,
            category,
            description,
            actor: req.user
        });

        return res.status(201).json({
            success: true,
            message: 'Product created successfully',
            data: product
        });
    } catch (error) {
        console.error('Create product error:', error);
        return res.status(400).json({
            success: false,
            message: error.message || 'Error creating product'
        });
    }
});

/**
 * PUT /api/products/:id
 * Update product (Admin only)
 */
router.put('/:id', requireModule('products'), async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid product ID'
            });
        }

        const product = await Product.update(parseInt(id), req.body, req.user);

        return res.status(200).json({
            success: true,
            message: 'Product updated successfully',
            data: product
        });
    } catch (error) {
        console.error('Update product error:', error);
        return res.status(400).json({
            success: false,
            message: error.message || 'Error updating product'
        });
    }
});

/**
 * DELETE /api/products/:id
 * Deactivate product (Admin only)
 */
router.delete('/:id', requireModule('products'), async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid product ID'
            });
        }

        const result = await Product.deactivate(parseInt(id), req.user);

        return res.status(200).json({
            success: true,
            message: 'Product deactivated successfully',
            data: result
        });
    } catch (error) {
        console.error('Delete product error:', error);
        return res.status(400).json({
            success: false,
            message: error.message || 'Error deactivating product'
        });
    }
});

/**
 * POST /api/products/:id/adjust-stock
 * Adjust product stock (Admin only)
 */
router.post('/:id/adjust-stock', requireModule('inventory'), async (req, res) => {
    try {
        const { id } = req.params;
        const { quantity, direction, reason } = req.body || {};

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid product ID'
            });
        }

        if (!Number.isSafeInteger(quantity) || quantity === 0 ||
            (direction !== undefined && quantity < 0)) {
            return res.status(400).json({
                success: false,
                message: 'Quantity must be a valid non-zero whole number'
            });
        }
        if (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 200) {
            return res.status(400).json({
                success: false,
                message: 'Stock adjustment reason must be 5-200 characters'
            });
        }

        if (direction !== undefined && !['ADD', 'REMOVE'].includes(direction)) {
            return res.status(400).json({
                success: false,
                message: 'Direction must be ADD or REMOVE'
            });
        }
        const quantityDelta = direction
            ? direction === 'ADD' ? quantity : -quantity
            : -quantity;
        const result = await Product.updateStock(parseInt(id), quantityDelta, reason, req.user);

        return res.status(200).json({
            success: true,
            message: 'Stock adjusted successfully',
            data: result
        });
    } catch (error) {
        console.error('Adjust stock error:', error);
        return res.status(400).json({
            success: false,
            message: error.message || 'Error adjusting stock'
        });
    }
});

module.exports = router;
