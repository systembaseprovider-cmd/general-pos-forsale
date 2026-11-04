const express = require('express');
const Transaction = require('../models/Transaction');
const { normalizePaymentMethod } = require('../services/paymentMethod');
const { verifyToken, requireRole, requireModule } = require('../middleware/auth');
const { getBusinessDate } = require('../services/businessDate');

const router = express.Router();

function getTransactionScope(user) {
    return {
        branch: user.branch,
        userId: user.role === 'admin' ? undefined : user.id
    };
}

function isValidDateRange(start, end) {
    const isDate = value => typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    return isDate(start) && isDate(end) && start <= end;
}

// ========================================
// PROTECTED ROUTES (All authenticated users)
// ========================================

/**
 * POST /api/transactions
 * Create new transaction with items and update stock
 */
router.post('/', verifyToken, requireModule('pos'), async (req, res) => {
    try {
        const {
            txnNo,
            customerName,
            items,
            discountAmount,
            discountReason,
            discountType,
            priceOverrides,
            expectedTotal,
            tenderedAmount,
            changeAmount,
            paymentMethod,
            referenceNo,
            notes
        } = req.body || {};

        if (typeof txnNo !== 'string' || !txnNo.trim() || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Transaction number and items are required'
            });
        }

        if (!paymentMethod) {
            return res.status(400).json({
                success: false,
                message: 'Payment method is required'
            });
        }

        const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod);
        if (!normalizedPaymentMethod) {
            return res.status(400).json({
                success: false,
                message: 'Payment method must be CASH, CARD, BANK, or E-WALLET'
            });
        }
        if (['CARD', 'BANK', 'E-WALLET'].includes(normalizedPaymentMethod) &&
            (typeof referenceNo !== 'string' || !referenceNo.trim())) {
            return res.status(400).json({
                success: false,
                message: 'A payment reference number is required for card, bank, and e-wallet payments'
            });
        }

        const normalizedPriceOverrides = priceOverrides === undefined ? [] : priceOverrides;
        if (!Array.isArray(normalizedPriceOverrides)) {
            return res.status(400).json({ success: false, message: 'Price overrides must be a list' });
        }
        if (normalizedPriceOverrides.length > 0 && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Only an administrator can approve a price override' });
        }
        const overrideProductIds = new Set();
        const saleProductIds = new Set((items || []).map(item => item?.productId));
        for (const override of normalizedPriceOverrides) {
            const price = Number(override?.newUnitPrice);
            const reason = typeof override?.reason === 'string' ? override.reason.trim() : '';
            if (!Number.isSafeInteger(override?.productId) || override.productId <= 0 ||
                !Number.isFinite(price) || price <= 0 || price > 1000000 ||
                reason.length < 5 || reason.length > 200 || overrideProductIds.has(override.productId) ||
                !saleProductIds.has(override.productId)) {
                return res.status(400).json({ success: false, message: 'Each price override needs a unique product, valid price, and 5-200 character reason' });
            }
            overrideProductIds.add(override.productId);
        }

        const currentYear = Number(getBusinessDate().slice(0, 4));
        const expectedPrefix = `${req.user.branch}-${currentYear}-`;
        const normalizedTxnNo = txnNo.trim();
        if (!normalizedTxnNo.startsWith(expectedPrefix) ||
            !/^\d{5}$/.test(normalizedTxnNo.slice(expectedPrefix.length))) {
            return res.status(409).json({
                success: false,
                message: 'Transaction number does not match your branch or current year. Refresh and try again.'
            });
        }

        const transaction = await Transaction.create({
            txnNo: normalizedTxnNo,
            userId: req.user.id,
            cashierName: req.user.name,
            branch: req.user.branch,
            customerName: customerName || 'GUEST CUSTOMER',
            items,
            discountAmount: discountAmount === undefined ? 0 : Number(discountAmount),
            discountReason,
            discountType,
            priceOverrides: normalizedPriceOverrides,
            expectedTotal: Number(expectedTotal),
            tenderedAmount: Number(tenderedAmount),
            changeAmount: Number(changeAmount),
            paymentMethod: normalizedPaymentMethod,
            referenceNo: referenceNo || '',
            notes: notes || ''
        });

        const savedTransaction = transaction.idempotent
            ? await Transaction.getById(transaction.id, req.user.branch, req.user.role === 'admin' ? undefined : req.user.id)
            : transaction;
        return res.status(201).json({
            success: true,
            message: transaction.idempotent ? 'Previously saved transaction confirmed' : 'Transaction created successfully',
            data: savedTransaction
        });

    } catch (error) {
        console.error('Create transaction error:', error);
        const status = error.code === 'IDEMPOTENCY_CONFLICT' ||
            error.code === 'BUSINESS_DAY_CLOSED' ||
            /insufficient stock/i.test(error.message) ? 409 : 400;
        return res.status(status).json({
            success: false,
            message: error.message || 'Error creating transaction',
            ...(error.code === 'BUSINESS_DAY_CLOSED' ? { code: error.code, businessDate: error.businessDate } : {})
        });
    }
});

router.get('/refund-preview/:txnNo', verifyToken, requireModule('pos'), async (req, res) => {
    try {
        const transaction = await Transaction.getRefundPreview(req.params.txnNo, req.user.branch);
        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: 'Transaction not found in this branch'
            });
        }
        return res.status(200).json({ success: true, data: transaction });
    } catch (error) {
        console.error('Get refund preview error:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to load refundable transaction items'
        });
    }
});

router.get('/void-preview/:txnNo', verifyToken, requireRole('admin', 'cashier'), requireModule('pos'), async (req, res) => {
    try {
        const transaction = await Transaction.getVoidPreview(req.params.txnNo, req.user.branch);
        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: 'Transaction not found in this branch'
            });
        }
        return res.status(200).json({ success: true, data: transaction });
    } catch (error) {
        console.error('Get void preview error:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to load transaction for voiding'
        });
    }
});

router.post('/:id/void', verifyToken, requireRole('admin', 'cashier'), requireModule('pos'), async (req, res) => {
    try {
        const transactionId = Number(req.params.id);
        const { requestId, reason } = req.body || {};
        if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid transaction ID' });
        }

        const result = await Transaction.voidSale({
            transactionId,
            requestId,
            userId: req.user.id,
            cashierName: req.user.name,
            branch: req.user.branch,
            reason
        });
        return res.status(result.idempotent ? 200 : 201).json({
            success: true,
            message: result.idempotent ? 'Previously recorded void confirmed' : 'Transaction voided and item stock restored',
            data: result
        });
    } catch (error) {
        console.error('Void transaction error:', error);
        const status = error.code === 'IDEMPOTENCY_CONFLICT' ||
            error.code === 'BUSINESS_DAY_CLOSED' ||
            /already been voided|recorded refund cannot be voided/i.test(error.message)
            ? 409
            : /not found/i.test(error.message) ? 404 : 400;
        return res.status(status).json({
            success: false,
            message: error.message || 'Unable to void transaction',
            ...(error.code === 'BUSINESS_DAY_CLOSED' ? { code: error.code, businessDate: error.businessDate } : {})
        });
    }
});

router.post('/:id/refunds', verifyToken, requireRole('admin', 'cashier'), requireModule('pos'), async (req, res) => {
    try {
        const transactionId = Number(req.params.id);
        const { requestId, reason, items } = req.body || {};
        if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid transaction ID' });
        }

        const refund = await Transaction.refund({
            transactionId,
            requestId,
            userId: req.user.id,
            cashierName: req.user.name,
            branch: req.user.branch,
            reason,
            items
        });
        return res.status(refund.idempotent ? 200 : 201).json({
            success: true,
            message: refund.idempotent ? 'Previously recorded refund confirmed' : 'Refund recorded and item stock restored',
            data: refund
        });
    } catch (error) {
        console.error('Create refund error:', error);
        const status = error.code === 'IDEMPOTENCY_CONFLICT' ||
            error.code === 'BUSINESS_DAY_CLOSED' ||
            /already refunded|exceeds the remaining|different transaction/i.test(error.message)
            ? 409
            : /not found/i.test(error.message) ? 404 : 400;
        return res.status(status).json({
            success: false,
            message: error.message || 'Unable to record refund',
            ...(error.code === 'BUSINESS_DAY_CLOSED' ? { code: error.code, businessDate: error.businessDate } : {})
        });
    }
});

/**
 * GET /api/transactions/summary/date-range?start=2024-01-01&end=2024-01-31
 * Get sales summary for date range (SPECIFIC ROUTE - MUST BE BEFORE :id)
 */
router.get('/next-txn-no', verifyToken, requireModule('pos'), async (req, res) => {
    try {
        const branchCode = req.user.branch;
        const year = Number(getBusinessDate().slice(0, 4));
        const nextTxnNo = await Transaction.getNextTxnNo(branchCode, year);

        return res.status(200).json({
            success: true,
            data: {
                nextTxnNo,
                branchCode,
                year
            }
        });
    } catch (error) {
        console.error('Get next transaction number error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error generating next transaction number'
        });
    }
});

router.get('/summary/date-range', verifyToken, requireModule('reports'), async (req, res) => {
    try {
        const { start, end } = req.query;

        if (!isValidDateRange(start, end)) {
            return res.status(400).json({
                success: false,
                message: 'Valid start and end dates are required (YYYY-MM-DD), with start not after end'
            });
        }

        const scope = getTransactionScope(req.user);
        const summary = await Transaction.getSalesSummary(start, end, scope.branch, scope.userId);

        return res.status(200).json({
            success: true,
            data: summary,
            dateRange: { start, end }
        });

    } catch (error) {
        console.error('Get sales summary error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching sales summary'
        });
    }
});

/**
 * GET /api/transactions/summary/by-payment?start=2024-01-01&end=2024-01-31
 * Get sales breakdown by payment method (SPECIFIC ROUTE - MUST BE BEFORE :id)
 */
router.get('/summary/by-payment', verifyToken, requireModule('reports'), async (req, res) => {
    try {
        const { start, end } = req.query;

        if (!isValidDateRange(start, end)) {
            return res.status(400).json({
                success: false,
                message: 'Valid start and end dates are required (YYYY-MM-DD), with start not after end'
            });
        }

        const scope = getTransactionScope(req.user);
        const summary = await Transaction.getSalesByPaymentMethod(start, end, scope.branch, scope.userId);

        return res.status(200).json({
            success: true,
            data: summary,
            dateRange: { start, end }
        });

    } catch (error) {
        console.error('Get payment method summary error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching summary'
        });
    }
});

/**
 * GET /api/transactions/top-products?limit=10
 * Get top selling products (SPECIFIC ROUTE - MUST BE BEFORE :id)
 */
router.get('/top-products', verifyToken, requireModule('reports'), async (req, res) => {
    try {
        const { limit } = req.query;
        const parsedLimit = limit === undefined ? 10 : Number(limit);
        const queryLimit = Math.min(parsedLimit, 100);

        if (!Number.isInteger(queryLimit) || queryLimit < 1) {
            return res.status(400).json({
                success: false,
                message: 'Limit must be a positive number'
            });
        }

        const scope = getTransactionScope(req.user);
        const products = await Transaction.getTopProducts(queryLimit, scope.branch, scope.userId);

        return res.status(200).json({
            success: true,
            data: products,
            count: products.length
        });

    } catch (error) {
        console.error('Get top products error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching top products'
        });
    }
});

/**
 * GET /api/transactions/txn/:txnNo
 * Get transaction by transaction number (SPECIFIC PARAM - BEFORE GENERIC :id)
 */
router.get('/txn/:txnNo', verifyToken, async (req, res) => {
    try {
        const { txnNo } = req.params;

        if (!txnNo) {
            return res.status(400).json({
                success: false,
                message: 'Transaction number is required'
            });
        }

        const scope = getTransactionScope(req.user);
        const [transactionByCurrentNumber, transactionByOriginalNumber] = await Promise.all([
            Transaction.getByTxnNo(txnNo, scope.branch, scope.userId),
            Transaction.getByOriginalTxnNo(txnNo, scope.branch, scope.userId)
        ]);
        if (transactionByCurrentNumber && transactionByOriginalNumber &&
            transactionByCurrentNumber.id !== transactionByOriginalNumber.id) {
            return res.status(409).json({
                success: false,
                message: 'This number belongs to two sales. Select the correct receipt from saved sales history.'
            });
        }
        const transaction = transactionByCurrentNumber || transactionByOriginalNumber;

        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: 'Transaction not found'
            });
        }

        return res.status(200).json({
            success: true,
            data: transaction
        });

    } catch (error) {
        console.error('Get transaction by txnNo error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching transaction'
        });
    }
});

/**
 * GET /api/transactions/user/:userId
 * Get transactions by user (cashier) (SPECIFIC PARAM - BEFORE GENERIC :id)
 */
router.get('/user/:userId', verifyToken, requireModule('reports'), async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit, offset } = req.query;

        const parsedUserId = Number(userId);
        if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid user ID'
            });
        }
        if (req.user.role !== 'admin' && parsedUserId !== req.user.id) {
            return res.status(403).json({
                success: false,
                message: 'Cashiers may only view their own transactions'
            });
        }

        const queryLimit = limit === undefined ? 50 : Math.min(Number(limit), 100);
        const queryOffset = offset === undefined ? 0 : Number(offset);
        if (!Number.isInteger(queryLimit) || queryLimit < 1 || !Number.isInteger(queryOffset) || queryOffset < 0) {
            return res.status(400).json({
                success: false,
                message: 'Limit and offset must be valid non-negative integers'
            });
        }

        const transactions = await Transaction.getByUserId(parsedUserId, queryLimit, queryOffset, req.user.branch);

        return res.status(200).json({
            success: true,
            data: transactions,
            count: transactions.length
        });

    } catch (error) {
        console.error('Get user transactions error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching transactions'
        });
    }
});

router.get('/recent', verifyToken, requireModule('pos'), async (req, res) => {
    try {
        const requestedLimit = req.query.limit === undefined ? 100 : Number(req.query.limit);
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
            return res.status(400).json({
                success: false,
                message: 'Limit must be a positive integer'
            });
        }

        const limit = Math.min(requestedLimit, 100);
        const scope = getTransactionScope(req.user);
        const transactions = await Transaction.getAll(limit, 0, scope.branch, scope.userId);
        return res.status(200).json({
            success: true,
            data: transactions,
            count: transactions.length
        });
    } catch (error) {
        console.error('Get recent transactions error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching recent transactions'
        });
    }
});

/**
 * GET /api/transactions
 * Get all transactions with pagination
 */
router.get('/', verifyToken, requireModule('reports'), async (req, res) => {
    try {
        const { limit, offset } = req.query;
        const queryLimit = limit === undefined ? 50 : Math.min(Number(limit), 100);
        const queryOffset = offset === undefined ? 0 : Number(offset);

        if (!Number.isInteger(queryLimit) || queryLimit < 1 || !Number.isInteger(queryOffset) || queryOffset < 0) {
            return res.status(400).json({
                success: false,
                message: 'Limit must be positive and offset must be non-negative'
            });
        }

        const scope = getTransactionScope(req.user);
        const transactions = await Transaction.getAll(queryLimit, queryOffset, scope.branch, scope.userId);
        const total = await Transaction.count(scope.branch, scope.userId);

        return res.status(200).json({
            success: true,
            data: transactions,
            pagination: {
                limit: queryLimit,
                offset: queryOffset,
                total: total
            }
        });

    } catch (error) {
        console.error('Get transactions error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching transactions'
        });
    }
});

/**
 * GET /api/transactions/:id
 * Get transaction by ID with all items (MUST BE LAST - CATCHES REMAINING PARAMS!)
 */
router.get('/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid transaction ID'
            });
        }

        const scope = getTransactionScope(req.user);
        const transaction = await Transaction.getById(Number(id), scope.branch, scope.userId);

        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: 'Transaction not found'
            });
        }

        return res.status(200).json({
            success: true,
            data: transaction
        });

    } catch (error) {
        console.error('Get transaction error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching transaction'
        });
    }
});

module.exports = router;
