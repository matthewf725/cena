import { supabase } from './supabase';

export const calPolyDemo = process.env.EXPO_PUBLIC_CENA_CAL_POLY_DEMO === '1';
export const calPolyPickupArea = { latitude: 35.2993, longitude: -120.6599, label: '1 Grand Ave, San Luis Obispo' };

export type DemoOrder = {
  id: string;
  restaurant_id: string;
  status: 'placed' | 'accepted' | 'preparing' | 'ready' | 'completed';
  payment_status: 'pay_at_pickup' | 'paid';
  payment_method: 'pay_at_pickup' | 'stripe_checkout';
  subtotal_cents: number;
  total_cents?: number | null;
  pickup_starts_at: string;
  pickup_ends_at?: string | null;
  pickup_mode?: 'counter' | 'curbside';
  restaurant_timezone: string;
  restaurants: { name: string; address: string };
  order_items: {
    item_id: string;
    name_snapshot: string;
    quantity: number;
    prep_steps_snapshot: string[];
    options_snapshot: unknown;
  }[];
};

export type CalPolyDemo = {
  profile: {
    display_name: string;
    equipment: string[];
  };
  pickup_area: typeof calPolyPickupArea;
  orders: DemoOrder[];
  upcoming_pickup?: DemoOrder | null;
};

export async function loadCalPolyDemo(signal: AbortSignal): Promise<CalPolyDemo> {
  if (!supabase) throw new Error('The demo needs a Supabase connection.');
  const [{ data, error }, { data: carbonara }] = await Promise.all([
    supabase.rpc('get_cal_poly_demo').abortSignal(signal),
    supabase.from('catalog_items').select('id,published_steps,restaurants!inner(slug)')
      .eq('restaurants.slug', 'cal-poly-giuseppes').eq('name', 'Carbonara Kit')
      .eq('active', true).not('published_at', 'is', null).abortSignal(signal).maybeSingle(),
  ]);
  if (error) throw error;
  if (typeof data?.profile?.display_name !== 'string' || !Array.isArray(data.orders)) {
    throw new Error('The demo account is unavailable.');
  }
  const demo = data as CalPolyDemo;
  const visibleDemo = demo.upcoming_pickup && !demo.orders.some(order => order.id === demo.upcoming_pickup?.id)
    ? { ...demo, orders: [demo.upcoming_pickup, ...demo.orders] }
    : demo;

  // The demo order is a fixture. Show the currently published Carbonara recipe in its walkthrough.
  if (!carbonara?.published_steps?.length) return visibleDemo;
  const orders = visibleDemo.orders.map(order => order.order_items.some(item => item.item_id === carbonara.id)
    ? { ...order, order_items: order.order_items.map(item => item.item_id === carbonara.id
      ? { ...item, prep_steps_snapshot: carbonara.published_steps } : item) }
    : order);
  return { ...visibleDemo, orders };
}
