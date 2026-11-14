import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { kitchens, toMeal, type Kitchen } from './data';
import { createAuthTimeoutFetch } from './auth-timeout-fetch';
import { validateCheckoutQuote, type CheckoutQuote } from './checkout-quote';
export type { CheckoutQuote } from './checkout-quote';

// Public reads work anonymously; order writes require an email OTP session.
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
export const supabase: SupabaseClient | null = url && key ? createClient(url, key, {
  global: { fetch: createAuthTimeoutFetch(globalThis.fetch.bind(globalThis)) },
  auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
}) : null;

export const sendEmailCode = async (email: string) => {
  if (!supabase) return { error: new Error('Backend is not configured') };
  return supabase.auth.signInWithOtp({ email: email.trim().toLowerCase() });
};
export const verifyEmailCode = async (email: string, token: string) => {
  if (!supabase) return { error: new Error('Backend is not configured') };
  return supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token, type: 'email' });
};

// Available meal kits are derived per slot from available_qty - reserved_qty.
export async function fetchPickupAvailability(restaurantId: string) {
  if (!supabase) return { data: null, error: null };
  const { data: slots, error } = await supabase.from('pickup_slots').select('id,restaurant_id,starts_at,ends_at,cutoff_at,capacity,reserved_count')
    .eq('restaurant_id', restaurantId).eq('active', true).gt('starts_at', new Date().toISOString()).gt('cutoff_at', new Date().toISOString()).order('starts_at');
  if (error || !slots?.length) return { data: error ? null : [], error };
  const { data: inventory, error: inventoryError } = await supabase.from('slot_item_inventory').select('slot_id,item_id,available_qty,reserved_qty').in('slot_id', slots.map(x => x.id));
  return { data: inventoryError ? null : slots.map(slot => ({ ...slot, items: (inventory || []).filter(i => i.slot_id === slot.id).map(i => ({ ...i, remaining: i.available_qty - i.reserved_qty })) })), error: inventoryError };
}

export async function loadKitchenMenu(kitchen: Kitchen): Promise<Kitchen> {
  if (!supabase || !kitchen.backendId) return kitchen;
  const restaurantId = kitchen.backendId;
  const [menu, availability] = await Promise.all([
    supabase.from('catalog_items').select('id,name,description,price_cents,prepared_meal_total_cents,equipment,published_steps,image_key')
      .eq('restaurant_id', restaurantId).eq('active', true).not('published_at', 'is', null).order('name'),
    fetchPickupAvailability(restaurantId),
  ]);
  if (menu.error || availability.error) throw menu.error ?? availability.error;
  const slots = (availability.data ?? []).filter(slot => slot.reserved_count < slot.capacity);
  const meals = (menu.data ?? []).map(toMeal);
  return {
    ...kitchen,
    meals: meals.filter(meal => slots.some(slot => slot.items.some(item => item.item_id === meal.id && item.remaining > 0))),
    pickupSlots: slots.filter(slot => slot.items.some(item => item.remaining > 0)).map(slot => ({
      id: slot.id, startsAt: slot.starts_at, endsAt: slot.ends_at, cutoffAt: slot.cutoff_at,
      remaining: Object.fromEntries(slot.items.map(item => [item.item_id, item.remaining])),
    })),
  };
}

export async function fetchKitchenBySlug(slug: string): Promise<Kitchen | null> {
  if (!supabase) return kitchens.find(kitchen => kitchen.id === slug) ?? null;
  const { data, error } = await supabase.from('restaurants')
    .select('id,slug,name,cuisine,image_key,address,timezone,curbside_enabled')
    .eq('slug', slug).eq('active', true).maybeSingle();
  if (error) throw error;
  return data ? {
    id: data.slug, backendId: data.id, name: data.name, cuisine: data.cuisine,
    image: data.image_key ?? 'mediterranean', address: data.address, timezone: data.timezone,
    curbsideEnabled: data.curbside_enabled, meals: [],
  } : null;
}

export type CheckoutInput = { restaurantId: string; slotId: string; idempotencyKey: string; pickupMode: 'counter'|'curbside'; vehicle?: Record<string, string>; items: { item_id: string; quantity: number }[]; promoCode?: string; expectedAmountCents: number };
export type CheckoutSession = { order_id: string; checkout_url: string; subtotal_cents?:number;discount_cents?:number;amount_cents?:number;currency?:string;promo_code?:string|null } | { order_id: string; status: 'paid'; subtotal_cents?:number;discount_cents?:number;amount_cents?:number;currency?:string;promo_code?:string|null };
export function isTrustedCheckoutURL(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' && !url.username && !url.password && !url.port;
  } catch { return false; }
}
export class CheckoutRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly checkoutStatus?: string, public readonly orderId?: string, public readonly reason?: string) { super(message); this.name = 'CheckoutRequestError'; }
}
async function checkoutRequest(path: string, init: RequestInit = {}) {
  if (!supabase) throw new Error('Payments require a configured Cena account.');
  const apiUrl = process.env.EXPO_PUBLIC_CENA_API_URL;
  if (!apiUrl) throw new Error('Secure checkout is not configured yet. Please try again later.');
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Sign in to continue to secure checkout.');
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, ...(init.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new CheckoutRequestError(data?.error || data?.message || 'Secure checkout could not be started.', response.status, data?.status, data?.order_id, data?.code);
  return data;
}
export async function quoteCheckout(input: Omit<CheckoutInput,'idempotencyKey'|'pickupMode'|'vehicle'|'promoCode'|'expectedAmountCents'> & {promoCode?:string}): Promise<CheckoutQuote> {
  const data = await checkoutRequest('/v1/checkout/quote', { method:'POST', body:JSON.stringify({
    p_restaurant_id:input.restaurantId,p_slot_id:input.slotId,p_items:input.items,promo_code:input.promoCode?.trim()||undefined,
  }) });
  return validateCheckoutQuote(data, input);
}
export async function createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
  const data = await checkoutRequest('/v1/checkout', { method: 'POST', body: JSON.stringify({
    p_restaurant_id: input.restaurantId, p_slot_id: input.slotId, p_idempotency_key: input.idempotencyKey,
    p_pickup_mode: input.pickupMode, p_vehicle: input.vehicle || {}, p_items: input.items,
    promo_code: input.promoCode?.trim()||undefined,expected_amount_cents:input.expectedAmountCents,
  }) });
  if (typeof data.order_id !== 'string') throw new Error('Secure checkout returned an incomplete session.');
  if (data.status === 'paid' && typeof data.checkout_url !== 'string') return { order_id: data.order_id, status: 'paid' };
  if (typeof data.checkout_url !== 'string') throw new Error('Secure checkout returned an incomplete session.');
  if (!isTrustedCheckoutURL(data.checkout_url)) throw new Error('Secure checkout returned an untrusted payment link.');
  return { order_id: data.order_id, checkout_url: new URL(data.checkout_url).toString() };
}
export async function fetchCheckoutStatus(orderId: string): Promise<'pending'|'paid'|'expired'|'failed'|'refunded'> {
  const data = await checkoutRequest(`/v1/checkout/${encodeURIComponent(orderId)}`, { method: 'GET' });
  if (['pending', 'paid', 'expired', 'failed', 'refunded'].includes(data.status)) return data.status;
  throw new Error('Could not confirm payment status.');
}
export async function cancelCheckout(orderId: string): Promise<'cancelled'|'paid'|'expired'|'failed'|'pending'|'refunded'> {
  const data = await checkoutRequest(`/v1/checkout/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
  const status = data.status === 'canceled' ? 'cancelled' : data.status;
  if (['cancelled', 'paid', 'expired', 'failed', 'pending', 'refunded'].includes(status)) return status;
  throw new Error('Checkout cancellation could not be confirmed.');
}

export async function saveAnalyticsConsent(consented: boolean) {
  if (!supabase) return { error: null };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: new Error('Sign in first') };
  return supabase.from('consent_records').insert({ user_id: user.id, consent_type: 'analytics', policy_version: '2026-11-13', consent_action: consented ? 'granted' : 'revoked' });
}
export async function upsertCustomerProfile(displayName: string, phone: string, equipment: string[]) {
  if (!supabase) return { error: null };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: new Error('Sign in first') };
  return supabase.from('profiles').upsert({ id: user.id, display_name: displayName, phone: phone || null, equipment }, { onConflict: 'id' });
}
export async function fetchOrderHistory() {
  if (!supabase) return { data: null, error: null };
  return supabase.from('orders').select('id,restaurant_id,status,payment_method,payment_status,subtotal_cents,discount_cents,total_cents,promo_code_snapshot,discount_percent,created_at,pickup_starts_at,pickup_ends_at,restaurant_timezone,pickup_mode,restaurants(name,address),order_items(item_id,name_snapshot,quantity,unit_price_cents,prep_steps_snapshot)').order('created_at',{ascending:false}).limit(20);
}
export async function trackEvent(eventType: string, restaurantId?: string, payload: Record<string, unknown> = {}) {
  if (!supabase) return { error: null };
  return supabase.rpc('track_event', { p_event_type: eventType, p_restaurant_id: restaurantId || null, p_payload: payload });
}
