const test = require('node:test');
const assert = require('node:assert/strict');
const { readCartDraft, saveCartDraft } = require('../public/cart-draft');

function createStorage() {
    const values = new Map();
    return {
        getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key)
    };
}

test('cart drafts survive refresh and are scoped to the logged-in user and branch', () => {
    const storage = createStorage();
    const draft = {
        userId: 7,
        branch: '01',
        cart: [{ type: 'item', id: 3, code: 'C3', name: 'Coffee', price: 120, qty: 2 }],
        discountAmount: 10,
        discountReason: 'Member',
        discountType: 'PERCENT',
        heldOrders: [{
            id: 123,
            time: '10:00 AM',
            account: 'Guest Customer',
            cart: [{ type: 'item', id: 3, code: 'C3', name: 'Coffee', price: 120, qty: 1 }],
            discount: 0,
            discountReason: '',
            discountType: '',
            total: 120
        }],
        account: 'Juan'
    };

    saveCartDraft(storage, 'posCartDraft:7', draft);

    assert.deepEqual(readCartDraft(storage, 'posCartDraft:7', 7, '01'), draft);
    assert.throws(() => readCartDraft(storage, 'posCartDraft:7', 8, '01'), /does not match/);
    assert.throws(() => readCartDraft(storage, 'posCartDraft:7', 7, '02'), /does not match/);
});

test('empty cart removes the saved draft', () => {
    const storage = createStorage();
    const key = 'posCartDraft:7';

    saveCartDraft(storage, key, {
        userId: 7,
        branch: '01',
        cart: [{ type: 'item', code: 'C3', name: 'Coffee', price: 120, qty: 1 }],
        discountAmount: 0,
        discountReason: '',
        discountType: '',
        heldOrders: [],
        account: ''
    });
    assert.ok(storage.getItem(key));

    saveCartDraft(storage, key, {
        userId: 7,
        branch: '01',
        cart: [],
        discountAmount: 0,
        discountReason: '',
        discountType: '',
        heldOrders: [],
        account: ''
    });
    assert.equal(storage.getItem(key), null);
});

test('corrupt or invalid cart drafts are rejected instead of silently discarded', () => {
    const storage = createStorage();
    storage.setItem('posCartDraft:7', '{');
    assert.throws(() => readCartDraft(storage, 'posCartDraft:7', 7, '01'), SyntaxError);

    storage.setItem('posCartDraft:7', JSON.stringify({
        userId: 7,
        branch: '01',
        cart: [{ type: 'item', code: 'C3', name: 'Coffee', price: -1, qty: 1 }],
        discountAmount: 0,
        discountReason: '',
        discountType: '',
        heldOrders: [],
        account: ''
    }));
    assert.throws(() => readCartDraft(storage, 'posCartDraft:7', 7, '01'), /does not match/);
});
