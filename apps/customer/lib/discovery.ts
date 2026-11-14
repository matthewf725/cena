import type { Kitchen } from './data';
import { supabase } from './supabase';

export type PickupOrigin = { latitude: number; longitude: number };
export const sanFrancisco: PickupOrigin = { latitude: 37.7749, longitude: -122.4194 };

export type CuisineRail = { name: string; kitchens: Kitchen[] };
export type DiscoveryPage = {
  recents: Kitchen[];
  nearby: Kitchen[];
  categories: CuisineRail[];
  nextCursor: string | null;
};

export type DiscoveryFilters = {
  maxPriceCents: number | null;
  offersOnly: boolean;
  sameDayOnly: boolean;
  cuisine: string | null;
};

export type DiscoveryResultsPage = {
  kitchens: Kitchen[];
  nextOffset: number | null;
};

type DiscoveryInput = {
  origin: PickupOrigin;
  recentIds: string[];
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
type DiscoveryResponse = {
  recent: RestaurantRow[];
  nearby: RestaurantRow[];
  categories: { name: string; restaurants: RestaurantRow[] }[];
  next_cursor: string | null;
};

type DiscoveryResultsResponse = {
  results: RestaurantRow[];
  next_offset: number | null;
  has_more: boolean;
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

export function formatDistance(miles: number | undefined): string | undefined {
  if (miles === undefined || !Number.isFinite(miles) || miles < 0) return undefined;
  const value = miles < 0.1 ? '<0.1' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(miles);
  return `${value} mi away`;
}

export async function discoverPickupFeed(input: DiscoveryInput): Promise<DiscoveryPage> {
  if (!supabase) throw new Error('Restaurant discovery needs a Supabase connection.');
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

  return {
    recents: result.recent.map(toKitchen),
    nearby: result.nearby.map(toKitchen),
    categories: result.categories.map(({ name, restaurants }) => ({ name, kitchens: restaurants.map(toKitchen) })),
    nextCursor: result.next_cursor,
  };
}

export async function discoverPickupResults(input: {
  origin: PickupOrigin;
  query: string;
  filters: DiscoveryFilters;
  offset?: number;
}): Promise<DiscoveryResultsPage> {
  if (!supabase) throw new Error('Restaurant discovery needs a Supabase connection.');
  const { data, error } = await supabase.rpc('discover_pickup_results', {
    p_latitude: input.origin.latitude,
    p_longitude: input.origin.longitude,
    p_query: input.query || null,
    p_max_price_cents: input.filters.maxPriceCents,
    p_offers_only: input.filters.offersOnly,
    p_same_day_only: input.filters.sameDayOnly,
    p_cuisine: input.filters.cuisine,
    p_limit: 24,
    p_offset: input.offset ?? 0,
  });
  if (error) throw error;
  const response = data as DiscoveryResultsResponse;
  return {
    kitchens: response.results.map(toKitchen),
    nextOffset: response.has_more ? response.next_offset : null,
  };
}
