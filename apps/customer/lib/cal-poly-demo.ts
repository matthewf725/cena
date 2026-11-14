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
  const { data, error } = await supabase.rpc('get_cal_poly_demo').abortSignal(signal);
  if (error) throw error;
  if (typeof data?.profile?.display_name !== 'string' || !Array.isArray(data.orders)) {
    throw new Error('The demo account is unavailable.');
  }
  const demo = data as CalPolyDemo;
  return demo.upcoming_pickup && !demo.orders.some(order => order.id === demo.upcoming_pickup?.id)
    ? { ...demo, orders: [demo.upcoming_pickup, ...demo.orders] }
    : demo;
}
