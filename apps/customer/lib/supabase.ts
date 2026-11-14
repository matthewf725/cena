import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Kitchen, Meal } from './data';

// Public reads work anonymously; order writes require an email OTP session.
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
export const supabase: SupabaseClient | null = url && key ? createClient(url, key, {
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
    supabase.from('catalog_items').select('id,name,description,price_cents,regular_price_cents,equipment,published_steps,image_key')
      .eq('restaurant_id', restaurantId).eq('active', true).not('published_at', 'is', null).order('name'),
    fetchPickupAvailability(restaurantId),
  ]);
  if (menu.error || availability.error) throw menu.error ?? availability.error;
  const slots = (availability.data ?? []).filter(slot => slot.reserved_count < slot.capacity);
  const meals: Meal[] = (menu.data ?? []).map(item => ({
    id: item.id,
    backendItemId: item.id,
    name: item.name,
    subtitle: item.description,
    price: item.price_cents / 100,
    was: (item.regular_price_cents ?? item.price_cents) / 100,
    image: item.image_key ?? 'mediterranean',
    equipment: item.equipment?.[0],
    publishedSteps: item.published_steps ?? [],
  }));
  return {
    ...kitchen,
    meals: meals.filter(meal => slots.some(slot => slot.items.some(item => item.item_id === meal.id && item.remaining > 0))),
    pickupSlots: slots.filter(slot => slot.items.some(item => item.remaining > 0)).map(slot => ({
      id: slot.id, startsAt: slot.starts_at, endsAt: slot.ends_at, cutoffAt: slot.cutoff_at,
      remaining: Object.fromEntries(slot.items.map(item => [item.item_id, item.remaining])),
    })),
  };
}

export async function placeOrder(input: { restaurantId: string; slotId: string; idempotencyKey: string; pickupMode: 'counter'|'curbside'; vehicle?: Record<string, string>; items: { item_id: string; quantity: number }[] }) {
  if (!supabase) return { data: { id: `CN-${Date.now().toString().slice(-6)}`, status: 'placed' }, error: null };
  const apiUrl = process.env.EXPO_PUBLIC_CENA_API_URL;
  if (apiUrl) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return { data: null, error: new Error('Sign in to place an order') };
    try {
      const response = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ p_restaurant_id: input.restaurantId, p_slot_id: input.slotId, p_idempotency_key: input.idempotencyKey,
          p_pickup_mode: input.pickupMode, p_vehicle: input.vehicle || {}, p_items: input.items }),
      });
      const data = await response.json();
      return response.ok ? { data, error: null } : { data: null, error: new Error(data?.error || data?.message || 'Order service could not place your order') };
    } catch (e) { return { data: null, error: e instanceof Error ? e : new Error('Order service unavailable') }; }
  }
  return supabase.rpc('create_order', {
    p_restaurant_id: input.restaurantId, p_slot_id: input.slotId, p_idempotency_key: input.idempotencyKey,
    p_pickup_mode: input.pickupMode, p_vehicle: input.vehicle || {}, p_items: input.items,
  });
}

// The illustrative UI catalog uses local demo ids. Keep its checkout local; real catalog
// records should call placeOrder above once they have database UUIDs and a selected slot.
export async function saveOrder(order: Record<string, unknown>) {
  return { data: { ...order, id: `CN-${Date.now().toString().slice(-6)}`, status: 'placed' }, error: null };
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
  return supabase.from('orders').select('id,restaurant_id,status,subtotal_cents,created_at,pickup_starts_at,pickup_ends_at,restaurant_timezone,pickup_mode,restaurants(name,address),order_items(item_id,name_snapshot,quantity,unit_price_cents,prep_steps_snapshot)').order('created_at',{ascending:false}).limit(20);
}
export async function trackEvent(eventType: string, restaurantId?: string, payload: Record<string, unknown> = {}) {
  if (!supabase) return { error: null };
  return supabase.rpc('track_event', { p_event_type: eventType, p_restaurant_id: restaurantId || null, p_payload: payload });
}
