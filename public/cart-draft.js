(function (root, factory) {
  const cartDraft = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = cartDraft;
  } else {
    root.POSCartDraft = cartDraft;
  }
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  function isCartValid(cart) {
    return Array.isArray(cart) && cart.every(entry => {
      if (!entry || typeof entry !== 'object') return false;
      if (entry.type === 'subtotal') {
        return Number.isFinite(entry.amount) && entry.amount >= 0;
      }
      return entry.type === 'item' &&
        (typeof entry.code === 'string' || typeof entry.code === 'number') &&
        typeof entry.name === 'string' &&
        Number.isFinite(entry.price) && entry.price >= 0 &&
        Number.isSafeInteger(entry.qty) && entry.qty > 0;
    });
  }

  function isHeldOrdersValid(heldOrders) {
    return Array.isArray(heldOrders) && heldOrders.every(order =>
      order &&
      Number.isSafeInteger(order.id) &&
      typeof order.time === 'string' &&
      typeof order.account === 'string' &&
      isCartValid(order.cart) &&
      Number.isFinite(order.discount) && order.discount >= 0 &&
      Number.isFinite(order.total) && order.total >= 0
    );
  }

  function readCartDraft(storage, key, userId, branch) {
    const stored = storage.getItem(key);
    if (!stored) return null;

    const draft = JSON.parse(stored);
    if (!draft || draft.userId !== userId || draft.branch !== branch ||
        !isCartValid(draft.cart) || !isHeldOrdersValid(draft.heldOrders) ||
        !Number.isFinite(draft.discountAmount) || draft.discountAmount < 0 ||
        typeof draft.discountReason !== 'string' ||
        typeof draft.discountType !== 'string' ||
        typeof draft.account !== 'string') {
      throw new Error('Cart draft does not match the current user or has invalid data.');
    }

    return draft;
  }

  function saveCartDraft(storage, key, draft) {
    if (!draft.cart.length && !draft.heldOrders.length &&
        draft.discountAmount === 0 && !draft.account) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify(draft));
  }

  return { readCartDraft, saveCartDraft };
});
