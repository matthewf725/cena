import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCheckoutQuote } from '../apps/customer/lib/checkout-quote.ts';

const base = {
  restaurant_id: 'restaurant-1', slot_id: 'slot-1', subtotal_cents: 3390,
  discount_cents: 0, amount_cents: 3390, currency: 'usd',
  promo_code: null, discount_percent: null,
};
const input = { restaurantId: 'restaurant-1', slotId: 'slot-1' };
const invalid = (quote, requested = input) => assert.throws(
  () => validateCheckoutQuote(quote, requested),
  /Checkout quote was incomplete/,
);

test('accepts a complete exact no-promo quote', () => {
  assert.deepEqual(validateCheckoutQuote(base, input), base);
});

test('accepts a normalized requested promo with a recorded positive percentage', () => {
  const quote = { ...base, discount_cents: 339, amount_cents: 3051, promo_code: 'DINNER10', discount_percent: 10 };
  assert.deepEqual(validateCheckoutQuote(quote, { ...input, promoCode: ' dinner10 ' }), quote);
});

test('rejects mismatched cents, unsafe integers, and non-USD responses', () => {
  invalid({ ...base, amount_cents: 3389 });
  invalid({ ...base, subtotal_cents: Number.MAX_SAFE_INTEGER + 1, amount_cents: Number.MAX_SAFE_INTEGER + 1 });
  invalid({ ...base, currency: 'cad' });
});

test('rejects a missing, different, or invalid requested promo record', () => {
  const promoInput = { ...input, promoCode: 'DINNER10' };
  invalid(base, promoInput);
  invalid({ ...base, promo_code: 'OTHER10', discount_percent: 10 }, promoInput);
  invalid({ ...base, promo_code: 'DINNER10', discount_percent: 0 }, promoInput);
  invalid({ ...base, promo_code: 'DINNER10', discount_percent: 91 }, promoInput);
  invalid({ ...base, promo_code: 'DINNER10', discount_percent: 10.5 }, promoInput);
  invalid({ ...base, promo_code: 'DINNER10', discount_percent: 10 }, promoInput);
});

test('rejects promo metadata or discounts when no promo was requested', () => {
  invalid({ ...base, promo_code: 'DINNER10', discount_percent: 10 });
  invalid({ ...base, discount_cents: 100, amount_cents: 3290 });
});
