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

const DISCOVERY_CACHE_MS = 30_000;
const feedCache = new Map<string, { value: DiscoveryPage; expires: number; timer: ReturnType<typeof setTimeout> }>();
const feedRequests = new Map<string, Promise<DiscoveryPage>>();
const latestFeedRequests = new Map<string, Promise<DiscoveryPage>>();
function feedKey(input: DiscoveryInput): string | null {
  // Search text and personalized recents are never retained. Coordinates are short-lived in memory only.
  if (input.query) return null;
  return JSON.stringify([input.origin.latitude, input.origin.longitude, input.after ?? null]);
}
export function getCachedPickupFeed(input: DiscoveryInput): DiscoveryPage | null {
  const key = feedKey(input);
  if (!key) return null;
  const entry = feedCache.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) { clearTimeout(entry.timer); feedCache.delete(key); return null; }
  return entry.value;
}
export async function discoverPickupFeed(input: DiscoveryInput, options: { forceRefresh?: boolean } = {}): Promise<DiscoveryPage> {
  const key = feedKey(input);
  const personalized = input.recentIds.length > 0;
  if (key && !options.forceRefresh && !personalized) {
    const cached = getCachedPickupFeed(input);
    if (cached) return cached;
    const pending = feedRequests.get(key);
    if (pending) return pending;
  }
  if (key && (options.forceRefresh || personalized)) feedRequests.delete(key);
  const request = fetchPickupFeed(input);
  if (key) { latestFeedRequests.set(key, request); if (!personalized) feedRequests.set(key, request); }
  try {
    const value = await request;
    if (key && latestFeedRequests.get(key) === request) {
      const old = feedCache.get(key);
      if (old) clearTimeout(old.timer);
      if (feedCache.size >= 8 && !old) {
        const first = feedCache.keys().next().value!;
        clearTimeout(feedCache.get(first)!.timer);
        feedCache.delete(first);
      }
      const entry = { value: { ...value, recents: [] }, expires: Date.now() + DISCOVERY_CACHE_MS, timer: setTimeout(() => { feedCache.delete(key); }, DISCOVERY_CACHE_MS) };
      feedCache.set(key, entry);
    }
    return value;
  } finally {
    if (key && feedRequests.get(key) === request) feedRequests.delete(key);
    if (key && latestFeedRequests.get(key) === request) latestFeedRequests.delete(key);
  }
}

async function fetchPickupFeed(input: DiscoveryInput): Promise<DiscoveryPage> {
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
