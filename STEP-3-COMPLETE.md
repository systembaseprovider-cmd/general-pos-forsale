# Step 3: Persist Transactions to Database

> The original demo notes below included unsafe offline-success and payment claims. Current behavior: sales are confirmed only after database commit; a browser recovery snapshot is kept until confirmation; card, bank, and e-wallet payments are recorded only after the cashier manually verifies approval/receipt and enters the provider reference; the POS does not process or independently verify those payments. VAT remains the existing 12% tax-inclusive calculation and needs business/tax confirmation before production use.

## What Was Implemented

### Files Created:
1. **src/models/Transaction.js** - Transaction model with CRUD & reporting
2. **src/routes/transaction.routes.js** - Transaction API endpoints

### Files Modified:
1. **src/database.js** - Added Transactions & TransactionItems tables
2. **server.js** - Registered transaction routes
3. **public/pos.html** - Calls API to save transactions & updates stock

---

## Safety Features ✓

- ✅ **Database Transactions** - Uses BEGIN/COMMIT/ROLLBACK for data integrity
- ✅ **Stock Verification** - Checks sufficient stock before saving transaction
- ✅ **Stock Decrement** - Automatically reduces stock after each sale
- ✅ **Input Validation** - All amounts, quantities validated
- ✅ **SQL Injection Prevention** - Parameterized queries throughout
- ✅ **Error Handling** - Graceful fallback if API fails
- ✅ **Referential Integrity** - Foreign keys link transactions to users/products
- ✅ **Data Consistency** - Rollback on any error during insert

---

## Database Schema

### Transactions Table
```sql
CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    txnNo TEXT UNIQUE NOT NULL,                    -- Unique transaction number
    userId INTEGER NOT NULL,                        -- Cashier who made the sale
    cashierName TEXT NOT NULL,
    customerName TEXT DEFAULT 'GUEST CUSTOMER',
    subtotal REAL NOT NULL CHECK(subtotal >= 0),
    discountAmount REAL DEFAULT 0,
    vatableSales REAL NOT NULL,
    vatAmount REAL NOT NULL,
    totalAmount REAL NOT NULL CHECK(totalAmount >= 0),
    paymentMethod TEXT NOT NULL,                   -- CASH until provider integration
    tenderedAmount REAL NOT NULL DEFAULT 0,
    changeAmount REAL NOT NULL DEFAULT 0,
    branch TEXT NOT NULL DEFAULT '01',
    requestHash TEXT,
    referenceNo TEXT,
    notes TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(userId) REFERENCES users(id)
);
```

### TransactionItems Table (Line items in each transaction)
```sql
CREATE TABLE transactionItems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transactionId INTEGER NOT NULL,
    productId INTEGER NOT NULL,
    productCode TEXT NOT NULL,
    productName TEXT NOT NULL,
    unitPrice REAL NOT NULL CHECK(unitPrice >= 0),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    lineTotal REAL NOT NULL CHECK(lineTotal >= 0),
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE,
    FOREIGN KEY(productId) REFERENCES products(id)
);
```

---

## API Endpoints

### Create Transaction

**POST** `/api/transactions`
- Server-priced cash sale; database transaction saves items and decrements stock
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
```json
{
  "txnNo": "01-<current-year>-00001",
  "customerName": "Juan Dela Cruz",
  "items": [
    {
      "productId": 1,
      "quantity": 2
    }
  ],
  "expectedTotal": 240.00,
  "discountAmount": 0,
  "tenderedAmount": 500.00,
  "changeAmount": 260.00,
  "paymentMethod": "CASH",
  "notes": ""
}
```

### Refund a transaction

**GET** `/api/transactions/refund-preview/:txnNo` returns the remaining refundable quantities and discounted amounts for a sale in the authenticated cashier's branch.

**POST** `/api/transactions/:id/refunds` records a full or partial item refund. Cashiers and admins may submit refunds with a 5-200 character reason. Each request uses a UUID for safe retries; quantities cannot exceed the unrefunded sale quantities. Refunded quantities are restored to stock, and the refund plus stock updates and audit event are committed atomically. The POS records the refund but does not transfer money back through card, bank, or e-wallet providers.

The server ignores browser-provided cashier, price, line-total, subtotal, VAT, and total values. It gets cashier/branch from the authenticated account and calculates product prices, stock, discount cap (20%), total, and VAT inside the database transaction. `expectedTotal` is only checked against the computed amount; it is not used to calculate the sale.

### Void a completed sale

**GET** `/api/transactions/void-preview/:txnNo` checks a sale in the authenticated cashier's branch and reports whether it is eligible to void.

**POST** `/api/transactions/:id/void` voids the whole sale. Cashiers and admins must provide a 5-200 character reason and a UUID request ID. A sale with any recorded refund cannot be voided, and a void cannot be repeated with a different request. The sale status, stock restoration, and `TRANSACTION_VOIDED` audit event commit atomically. Voiding does not automatically return money through card, bank, or e-wallet providers; handle that separately.

**Response (Success):**
```json
{
  "success": true,
  "message": "Transaction created successfully",
  "data": {
    "id": 1,
    "txnNo": "01-2024-00001",
    "totalAmount": 240.00,
    "itemCount": 1,
    "timestamp": "2024-01-01T10:30:00.000Z"
  }
}
```

### Retrieve Transactions

**GET** `/api/transactions/:id`
- Get transaction by ID with all items

**GET** `/api/transactions/txn/:txnNo`
- Get transaction by transaction number

**GET** `/api/transactions?limit=50&offset=0`
- Get all transactions with pagination

**GET** `/api/transactions/user/:userId?limit=50&offset=0`
- Get transactions by specific cashier

**GET** `/api/transactions/summary/date-range?start=2024-01-01&end=2024-01-31`
- Get sales summary (total, VAT, discount, count)

**GET** `/api/transactions/summary/by-payment?start=2024-01-01&end=2024-01-31`
- Get sales breakdown by payment method

**GET** `/api/transactions/top-products?limit=10`
- Get top 10 selling products

---

## How It Works

### Transaction Flow:

1. **Cashier scans items** → Added to cart
2. **Cash payment is confirmed locally**; card, bank, and e-wallet are cashier-verified and recorded manually
3. **Recovery snapshot is saved** in the cashier's browser before submission
4. **Backend loads current product prices, checks stock, recalculates totals, and commits sale/items/stock atomically**
5. **Receipt is shown only after a successful database response**
6. If the response is lost, the cart and same transaction number remain available for an idempotent retry

### Stock Management:

```
BEFORE SALE:
Product 101 (Coffee) → Stock: 50

DURING SALE:
Cart: 2x Coffee

ON TRANSACTION COMPLETE:
API saves transaction ✓
API decrements stock: 50 - 2 = 48 ✓
Product 101 → Stock: 48
```

---

## Error Handling

✅ **Stock unavailable?** → Transaction rejected with error message  
✅ **API/network error?** → No success receipt; cart and browser recovery snapshot are retained  
✅ **Retry after an unknown response?** → Same transaction number and payload are idempotent  
✅ **Database error?** → Automatic rollback, no partial data  
✅ **Card/bank/e-wallet?** → Cashier must verify approval or receipt with the provider and enter the reference; the POS does not process or independently verify payment

---

## Testing

### 1. Complete a sale & save to database:
```bash
# After confirming a CASH, BANK, or E-WALLET sale
# Check: http://localhost:3000/api/transactions
```

### 2. Get transaction by ID:
```bash
curl -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/transactions/1
```

### 3. Get sales summary:
```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/api/transactions/summary/date-range?start=2024-01-01&end=2024-12-31"
```

### 4. Get top products:
```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/api/transactions/top-products?limit=10"
```

### 5. Get sales by payment method:
```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/api/transactions/summary/by-payment?start=2024-01-01&end=2024-12-31"
```

---

## What Works Now

✅ **Transactions saved** - Every sale persisted to database  
✅ **Stock tracking** - Inventory decrements after each sale  
✅ **Refunds and sale voids** - Refund quantity limits, full-sale void protection, stock restoration, and audit history  
✅ **Receipt history** - Can retrieve any past receipt  
✅ **Sales reports** - Summarize sales by date, payment method, products  
✅ **Data integrity** - Transactions are atomic (all-or-nothing)  
✅ **Error recovery** - Graceful handling of network/database errors  

---

## Database Features

### Automatic Calculations:
- VAT calculation (12%)
- Line totals for each item
- Transaction totals
- Payment method breakdown

### Query Features:
- Filter by user (cashier)
- Filter by date range
- Filter by payment method
- Top products ranking
- Sales summary with averages

### Data Preservation:
- Soft deletes (products never lost)
- Complete audit trail (timestamps)
- All transaction details stored
- All line items preserved

---

## Payment Modes

- CASH, CARD, BANK, and E-WALLET methods are saved with each transaction
- Card, bank, and e-wallet sales require cashier verification and a provider reference; no payment provider integration is configured

## Local secrets and backups

- On startup, the server loads the untracked local `.env` file. Keep `JWT_SECRET` stable and private; changing it signs out active users.
- A SQLite-consistent backup is created at startup and every 24 hours in `backups/`. Backups older than 30 days are removed. Set `POS_BACKUP_DIR` to use another local folder.
- To restore, stop the POS server, then run `node scripts/restore-backup.js "backups\\<backup-file>.db"`. The script checks SQLite integrity, refuses to proceed if the server is running, and keeps a copy of the current database before replacing it.
- Test restore procedures periodically using a copy of the live database before relying on them for disaster recovery.

---

## ⚠️ Safety Checklist

- ✅ Database transactions (ACID compliance)
- ✅ Stock verification before sale
- ✅ Stock decrement after sale
- ✅ No negative stock allowed
- ✅ Foreign key constraints
- ✅ No SQL injection
- ✅ Authorization checks
- ✅ Error rollback
- ✅ Network failure graceful handling
- ✅ All amounts validated

---

**Status:** Core transaction, refund, and local-backup paths are implemented. Payment provider integrations and production tax compliance are not implemented.

## Audit Trail

- Successful discounted sales add a `DISCOUNT_APPLIED` audit event in the same SQLite transaction as the sale. Discounts require a type and cashier-entered 5-200 character reason.
- Cart voids require a reason and are recorded before the UI clears the cart. Completed-sale refunds and full-sale voids are separately recorded with a reason, restored stock, and an audit event; voided sales are excluded from sales and top-product reports.
- Admin stock adjustments require a reason and update inventory plus their `STOCK_ADJUSTED` event atomically.
- `GET /api/audit?limit=100&offset=0` is admin-only and returns only the authenticated admin's branch. Cashiers may submit `POST /api/audit/cart-voids`; actors and timestamps are supplied by the server.
- Admins can view recent events in the Sales Report modal. Audit entries are append-only through the application; there is no UI/API to edit or delete them.
- Price overrides remain disabled. Refunds are cashier/admin actions; the POS records them but does not transfer money back through a payment provider.

All transactions are now:
- Saved to database
- Tracked by cashier
- Queryable by date/payment method
- Linked to product stock

Stock is automatically managed:
- Verified before transaction
- Decremented after transaction
- Cannot go negative

Ready for Step 4 (Payment Gateway).
