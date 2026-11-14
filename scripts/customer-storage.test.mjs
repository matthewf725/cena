import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  customerStateKey,
  discardLegacyCustomerState,
  guestCustomerStateKey,
  legacyCustomerStateKey,
  loadCustomerLocalState,
  saveCustomerLocalState,
} from '../apps/customer/lib/local-state.ts';

class MemoryStorage {
  values = new Map();
  async getItem(key) { return this.values.get(key) ?? null; }
  async setItem(key, value) { this.values.set(key, value); }
  async removeItem(key) { this.values.delete(key); }
}

const cartA = { itemA: { meal: { id: 'itemA', name: 'Kit A', subtitle: 'A real meal kit', price: 12.5, image: 'rigatoni', backendItemId: 'itemA', publishedSteps: ['Heat the sauce'] }, qty: 2, options: '', restaurantId: 'kitchen-a' } };

test('unowned legacy customer blob is deleted without importing personal fields or ambiguous cart', async () => {
  const storage = new MemoryStorage();
  storage.values.set(legacyCustomerStateKey, JSON.stringify({
    cart: cartA, email: 'old@example.test', phone: '555-0100', displayName: 'Old profile',
    equipment: ['Oven'], analyticsConsented: true, termsAccepted: true,
  }));
  storage.values.set('cena.customer.profile-session-user.v1', 'old-user-id');
  storage.values.set('cena.customer.analytics-consent-explicit.v1', 'true');

  const guest = await loadCustomerLocalState(storage, null);
  const account = await loadCustomerLocalState(storage, 'user-a');

  assert.equal(storage.values.has(legacyCustomerStateKey), false);
  assert.equal(storage.values.has('cena.customer.profile-session-user.v1'), false);
  assert.equal(storage.values.has('cena.customer.analytics-consent-explicit.v1'), false);
  assert.deepEqual(guest, { cart: {}, cartRevision: '', demoRecentIds: [], demoRecentMeals: [] });
  assert.deepEqual(account, { cart: {}, cartRevision: '', demoRecentIds: [], demoRecentMeals: [] });
});

test('guest checkout bag can be adopted by one account without being mixed into another account', async () => {
  const storage = new MemoryStorage();
  const guest = { cart: cartA, cartRevision: 'rev-1', demoRecentIds: ['kitchen-a'], demoRecentMeals: ['itemA'] };
  await saveCustomerLocalState(storage, null, guest);
  await saveCustomerLocalState(storage, 'user-a', guest);

  assert.deepEqual((await loadCustomerLocalState(storage, 'user-a')).cart, cartA);
  assert.deepEqual(await loadCustomerLocalState(storage, 'user-b'), {
    cart: {}, cartRevision: '', demoRecentIds: [], demoRecentMeals: [],
  });
  assert.deepEqual((await loadCustomerLocalState(storage, null)).cart, cartA);
});

test('account bags and reload state are isolated by user ID', async () => {
  const storage = new MemoryStorage();
  const cartB = { itemB: { meal: { id: 'itemB', name: 'Kit B', subtitle: 'Another kit', price: 9.5, image: 'tacos', backendItemId: 'itemB' }, qty: 1, options: '', restaurantId: 'kitchen-b' } };
  await saveCustomerLocalState(storage, 'user-a', { cart: cartA, cartRevision: 'a1' });
  await saveCustomerLocalState(storage, 'user-b', { cart: cartB, cartRevision: 'b1' });

  assert.deepEqual((await loadCustomerLocalState(storage, 'user-a')).cart, cartA);
  assert.deepEqual((await loadCustomerLocalState(storage, 'user-b')).cart, cartB);
  assert.notEqual(customerStateKey('user-a'), customerStateKey('user-b'));
  assert.equal(customerStateKey(null), guestCustomerStateKey);
});

test('serialized state allowlists cart fields and excludes profile, contact, consent, and terms', async () => {
  const storage = new MemoryStorage();
  await saveCustomerLocalState(storage, 'user-a', {
    cart: cartA, cartRevision: 'rev-a', demoRecentIds: ['kitchen-a'], demoRecentMeals: ['itemA'],
    email: 'private@example.test', phone: '555-0199', displayName: 'Private Name',
    equipment: ['Oven'], analyticsConsented: true, termsAccepted: true,
  });

  const raw = storage.values.get(customerStateKey('user-a'));
  assert.ok(raw);
  for (const field of ['email', 'phone', 'displayName', 'equipment', 'analyticsConsented', 'termsAccepted']) {
    assert.equal(raw.includes(field), false, `Serialized user state should not contain ${field}`);
  }
  assert.deepEqual(await loadCustomerLocalState(storage, 'user-a'), {
    cart: cartA, cartRevision: 'rev-a', demoRecentIds: [], demoRecentMeals: [],
  });
});

test('corrupt scoped storage returns an empty bag without changing another owner', async () => {
  const storage = new MemoryStorage();
  await saveCustomerLocalState(storage, 'user-a', { cart: cartA, cartRevision: 'a1' });
  storage.values.set(customerStateKey('user-b'), '{broken');

  assert.deepEqual(await loadCustomerLocalState(storage, 'user-b'), {
    cart: {}, cartRevision: '', demoRecentIds: [], demoRecentMeals: [],
  });
  assert.deepEqual((await loadCustomerLocalState(storage, 'user-a')).cart, cartA);
  await discardLegacyCustomerState(storage);
});
