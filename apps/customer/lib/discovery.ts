import type { CatalogMealRow, Kitchen, Meal } from './data';
import { kitchens, toMeal } from './data';
import { supabase } from './supabase';

export type PickupOrigin = { latitude: number; longitude: number };
export const sanFrancisco: PickupOrigin = { latitude: 37.7749, longitude: -122.4194 };

export type MealTile = { kitchen: Kitchen; meal: Meal };
export type CuisineRail = { name: string; kitchens: Kitchen[] };
export type DiscoveryPage = {
  recents: Kitchen[];
  recentMeals: MealTile[];
  explore: MealTile[];
  nearby: Kitchen[];
  categories: CuisineRail[];
  nextCursor: string | null;
};

type DiscoveryInput = {
  origin: PickupOrigin;
  recentIds: string[];
  recentMealIds: string[];
  after?: string;
  query: string;
};

type RestaurantRow = {
  id: string;
  slug: string;
  name: string;
  cuisine: string;
  image_key: string | null;
  address: string;
  timezone: string;
  curbside_enabled: boolean;
  latitude: number | null;
  longitude: number | null;
  distance_miles: number | null;
  next_slot: { id: string; starts_at: string; ends_at: string; cutoff_at: string } | null;
};
type MealRow = CatalogMealRow;
type DiscoveryResponse = {
  recent: RestaurantRow[];
  explore: { restaurant: RestaurantRow; meal: MealRow }[];
  nearby: RestaurantRow[];
  categories: { name: string; restaurants: RestaurantRow[] }[];
  next_cursor: string | null;
};

function toKitchen(row: RestaurantRow): Kitchen {
  return {
    id: row.slug,
    backendId: row.id,
    name: row.name,
    cuisine: row.cuisine,
    image: row.image_key ?? 'mediterranean',
    address: row.address,
    timezone: row.timezone,
    curbsideEnabled: row.curbside_enabled,
    latitude: row.latitude ?? undefined,
    longitude: row.longitude ?? undefined,
    distanceMiles: row.distance_miles ?? undefined,
    meals: [],
    pickupSlots: row.next_slot ? [{
      id: row.next_slot.id,
      startsAt: row.next_slot.starts_at,
      endsAt: row.next_slot.ends_at,
      cutoffAt: row.next_slot.cutoff_at,
      remaining: {},
    }] : [],
  };
}

async function fetchRecentMeals(ids: string[]): Promise<MealTile[]> {
  if (!supabase || ids.length === 0) return [];
  const { data, error } = await supabase.from('catalog_items').select(`
    id,name,description,price_cents,prepared_meal_total_cents,image_key,equipment,published_steps,
    restaurants!inner(id,slug,name,cuisine,image_key,address,timezone,curbside_enabled,latitude,longitude)
  `).in('id', [...new Set(ids)]).eq('active', true).not('published_at', 'is', null);
  if (error) throw error;
  const byId = new Map((data ?? []).map((item: any) => [item.id, item]));
  return [...new Set(ids)].flatMap(id => {
    const item = byId.get(id) as (MealRow & { restaurants: Omit<RestaurantRow, 'next_slot'|'distance_miles'> }) | undefined;
    if (!item) return [];
    const restaurant = item.restaurants;
    return [{
      kitchen: toKitchen({ ...restaurant, next_slot: null, distance_miles: null }),
      meal: toMeal(item),
    }];
  });
}

export function formatDistance(miles: number | undefined, fromCity = false): string | undefined {
  if (miles === undefined || !Number.isFinite(miles) || miles < 0) return undefined;
  const value = miles < 0.1 ? '<0.1' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(miles);
  return `${value} mi ${fromCity ? 'from San Francisco' : 'away'}`;
}

function demoDistance(origin: PickupOrigin, restaurant: Kitchen) {
  if (restaurant.latitude === undefined || restaurant.longitude === undefined) return undefined;
  const radians = Math.PI / 180;
  const angle = Math.sin((restaurant.latitude - origin.latitude) * radians / 2) ** 2
    + Math.cos(origin.latitude * radians) * Math.cos(restaurant.latitude * radians)
    * Math.sin((restaurant.longitude - origin.longitude) * radians / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.min(1, Math.sqrt(angle)));
}

function demoDiscovery({ query, origin, recentIds, recentMealIds }: DiscoveryInput): DiscoveryPage {
  const matches = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase());
  const byDistance = kitchens.map(kitchen => ({ ...kitchen, distanceMiles: demoDistance(origin, kitchen) }))
    .sort((a, b) => (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity));
  const available = byDistance.filter(kitchen => matches(kitchen.name) || matches(kitchen.cuisine)
    || kitchen.meals.some(meal => matches(meal.name) || matches(meal.subtitle)));

  return {
    recents: [...new Set(recentIds)].flatMap(id => byDistance.filter(kitchen => kitchen.id === id)),
    recentMeals: [...new Set(recentMealIds)].flatMap(id => byDistance.flatMap(kitchen => kitchen.meals
      .filter(meal => meal.id === id).map(meal => ({ kitchen, meal })))),
    explore: available.flatMap(kitchen => kitchen.meals.filter(meal =>
      matches(meal.name) || matches(meal.subtitle) || matches(kitchen.name) || matches(kitchen.cuisine),
    ).map(meal => ({ kitchen, meal }))).slice(0, 8),
    nearby: available.slice(0, 8),
    categories: [...new Set(available.map(kitchen => kitchen.cuisine))].sort().map(name => ({
      name,
      kitchens: available.filter(kitchen => kitchen.cuisine === name).slice(0, 8),
    })),
    nextCursor: null,
  };
}

export async function discoverPickupFeed(input: DiscoveryInput): Promise<DiscoveryPage> {
  if (!supabase) return demoDiscovery(input);
  const args = {
    p_latitude: input.origin.latitude,
    p_longitude: input.origin.longitude,
    p_query: input.query || null,
    p_after: input.after ?? null,
    p_recent_ids: input.recentIds.slice(0, 20),
  };
  const apiUrl = process.env.EXPO_PUBLIC_CENA_API_URL;
  let result: DiscoveryResponse;
  if (apiUrl) {
    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/discovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error('Could not load pickup discovery.');
    result = await response.json() as DiscoveryResponse;
  } else {
    const { data, error } = await supabase.rpc('discover_pickup_feed', args);
    if (error) throw error;
    result = data as DiscoveryResponse;
  }

  const recentMeals = input.query.trim() ? [] : await fetchRecentMeals(input.recentMealIds.slice(0, 20));
  return {
    recents: result.recent.map(toKitchen),
    recentMeals,
    explore: result.explore.map(({ restaurant, meal }) => ({ kitchen: toKitchen(restaurant), meal: toMeal(meal) })),
    nearby: result.nearby.map(toKitchen),
    categories: result.categories.map(({ name, restaurants }) => ({ name, kitchens: restaurants.map(toKitchen) })),
    nextCursor: result.next_cursor,
  };
}
