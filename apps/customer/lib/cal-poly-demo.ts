import { supabase } from './supabase';

export const calPolyDemo = process.env.EXPO_PUBLIC_CENA_CAL_POLY_DEMO === '1';
export const calPolyPickupArea = { latitude: 35.2993, longitude: -120.6599, label: '1 Grand Ave, San Luis Obispo' };

const sampleOrders = [
  ['cal-poly-luna-red', 'De La Luna Paella Kit', '2026-11-12T02:00:00Z'],
  ['cal-poly-mamas-meatball', 'Spaghetti Meatball Kit', '2026-11-11T02:00:00Z'],
  ['cal-poly-piadina', 'Mushroom Pizza Kit', '2026-11-09T02:00:00Z'],
  ['cal-poly-giuseppes', 'Carbonara Kit', '2026-11-07T02:00:00Z'],
] as const;

export type DemoOrder = {
  id: string;
  restaurant_id: string;
  status: 'completed';
  payment_status: 'pay_at_pickup';
  payment_method: 'pay_at_pickup';
  subtotal_cents: number;
  pickup_starts_at: string;
  restaurant_timezone: string;
  restaurants: { name: string; address: string };
  order_items: {
    item_id: string;
    name_snapshot: string;
    quantity: number;
    prep_steps_snapshot: string[];
    options_snapshot: { quantity: number; groups: { group_id: string; group_name: string; choices: { id: string; name: string }[] }[] }[];
  }[];
};

export async function loadSampleOrders(): Promise<DemoOrder[]> {
  if (!supabase) return [];
  const [restaurants, catalog] = await Promise.all([
    supabase.from('restaurants').select('id,slug,name,address,timezone')
      .in('slug', sampleOrders.map(([slug]) => slug)).eq('active', true),
    supabase.from('catalog_items').select('id,restaurant_id,name,price_cents,published_steps,option_groups')
      .in('name', sampleOrders.map(([, name]) => name)).eq('active', true).not('published_at', 'is', null),
  ]);
  if (restaurants.error || catalog.error) throw restaurants.error ?? catalog.error;
  return sampleOrders.flatMap(([slug, name, pickup]): DemoOrder[] => {
    const restaurant = restaurants.data?.find(row => row.slug === slug);
    const meal = restaurant && catalog.data?.find(row => row.restaurant_id === restaurant.id && row.name === name);
    if (!restaurant || !meal) return [];
    const finish = Array.isArray(meal.option_groups) ? meal.option_groups.find(group => group.id === 'finish') : undefined;
    const choice = finish?.choices?.find((option: { id: string; name: string }) => option.id === 'on_side');
    const groups = choice ? [{ group_id: finish.id, group_name: finish.name, choices: [choice] }] : [];
    return [{
      id: slug, restaurant_id: restaurant.id, status: 'completed', payment_status: 'pay_at_pickup',
      payment_method: 'pay_at_pickup', subtotal_cents: meal.price_cents, pickup_starts_at: pickup,
      restaurant_timezone: restaurant.timezone, restaurants: { name: restaurant.name, address: restaurant.address },
      order_items: [{ item_id: meal.id, name_snapshot: meal.name, quantity: 1,
        prep_steps_snapshot: meal.published_steps ?? [], options_snapshot: [{ quantity: 1, groups }] }],
    }];
  });
}
