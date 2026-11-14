export type CheckoutQuoteInput = {
  restaurantId: string;
  slotId: string;
  promoCode?: string;
};

export type CheckoutQuote = {
  restaurant_id: string;
  slot_id: string;
  subtotal_cents: number;
  discount_cents: number;
  amount_cents: number;
  currency: 'usd';
  promo_code: string | null;
  discount_percent: number | null;
};

const INVALID_QUOTE_MESSAGE = 'Checkout quote was incomplete. Please check the total again.';

export function validateCheckoutQuote(data: unknown, input: CheckoutQuoteInput): CheckoutQuote {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(INVALID_QUOTE_MESSAGE);
  const quote = data as Record<string, unknown>;
  const requestedPromo = input.promoCode?.trim().toUpperCase() || null;
  const validCents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

  if (
    quote.restaurant_id !== input.restaurantId || quote.slot_id !== input.slotId ||
    !validCents(quote.subtotal_cents) || !validCents(quote.discount_cents) || !validCents(quote.amount_cents) ||
    quote.currency !== 'usd' || quote.amount_cents !== quote.subtotal_cents - quote.discount_cents
  ) throw new Error(INVALID_QUOTE_MESSAGE);

  if (requestedPromo === null) {
    if (quote.promo_code !== null || quote.discount_cents !== 0 || quote.discount_percent !== null) {
      throw new Error(INVALID_QUOTE_MESSAGE);
    }
  } else if (
    quote.promo_code !== requestedPromo ||
    (quote.discount_cents as number) < 1 ||
    !Number.isSafeInteger(quote.discount_percent) ||
    (quote.discount_percent as number) < 1 || (quote.discount_percent as number) > 90
  ) {
    throw new Error(INVALID_QUOTE_MESSAGE);
  }

  return quote as unknown as CheckoutQuote;
}
