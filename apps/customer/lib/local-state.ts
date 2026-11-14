export type CustomerLocalSnapshot = {
  cart: Record<string, unknown>;
  cartRevision: string;
  demoRecentIds: string[];
  demoRecentMeals: string[];
};

type Storage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export const legacyCustomerStateKey = 'cena.customer.demo.v1';
export const guestCustomerStateKey = 'cena.customer.guest.v2';
const accountKeyPrefix = 'cena.customer.user.v2.';
const legacyPersonalKeys = [
  legacyCustomerStateKey,
  'cena.customer.profile-session-user.v1',
  'cena.customer.analytics-consent-explicit.v1',
];
const legacyCleanupByStorage = new WeakMap<object, Promise<void>>();

export function customerStateKey(userId: string | null) {
  return userId ? `${accountKeyPrefix}${userId}` : guestCustomerStateKey;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 30) : [];
}

function sanitizedCart(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const line = candidate as Record<string, unknown>;
    if (!line.meal || typeof line.meal !== 'object' || Array.isArray(line.meal)) continue;
    const meal = line.meal as Record<string, unknown>;
    const quantity = Number(line.qty);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50 || typeof line.restaurantId !== 'string' || !line.restaurantId
      || typeof meal.id !== 'string' || typeof meal.name !== 'string' || typeof meal.image !== 'string') continue;
    const safeMeal = {
      id: meal.id,
      name: meal.name,
      subtitle: typeof meal.subtitle === 'string' ? meal.subtitle : '',
      price: Number.isFinite(Number(meal.price)) && Number(meal.price) >= 0 ? Number(meal.price) : 0,
      ...(Number.isFinite(Number(meal.preparedMealTotalCents)) ? { preparedMealTotalCents: Number(meal.preparedMealTotalCents) } : {}),
      image: meal.image,
      ...(typeof meal.tag === 'string' ? { tag: meal.tag } : {}),
      ...(typeof meal.equipment === 'string' ? { equipment: meal.equipment } : {}),
      ...(typeof meal.backendItemId === 'string' ? { backendItemId: meal.backendItemId } : {}),
      ...(Array.isArray(meal.publishedSteps) ? { publishedSteps: meal.publishedSteps.filter((step): step is string => typeof step === 'string').slice(0, 30) } : {}),
    };
    result[key] = {
      meal: safeMeal,
      qty: quantity,
      options: typeof line.options === 'string' ? line.options : '',
      restaurantId: line.restaurantId,
    };
  }
  return result;
}

function snapshotFrom(value: unknown, userId: string | null): CustomerLocalSnapshot {
  if (!value || typeof value !== 'object') return { cart: {}, cartRevision: '', demoRecentIds: [], demoRecentMeals: [] };
  const candidate = value as Partial<CustomerLocalSnapshot>;
  return {
    cart: sanitizedCart(candidate.cart),
    cartRevision: typeof candidate.cartRevision === 'string' ? candidate.cartRevision : '',
    // Purchase history belongs to authenticated order history. Only demo/guest recents are local.
    demoRecentIds: userId ? [] : asStringArray(candidate.demoRecentIds),
    demoRecentMeals: userId ? [] : asStringArray(candidate.demoRecentMeals),
  };
}

/** Remove the unowned v1 blob; its fields cannot be safely attributed to the current account. */
export async function discardLegacyCustomerState(storage: Storage) {
  let cleanup = legacyCleanupByStorage.get(storage);
  if (!cleanup) {
    cleanup = Promise.all(legacyPersonalKeys.map(key => storage.removeItem(key).catch(() => {}))).then(() => {});
    legacyCleanupByStorage.set(storage, cleanup);
  }
  await cleanup;
}

export async function loadCustomerLocalState(storage: Storage, userId: string | null): Promise<CustomerLocalSnapshot> {
  await discardLegacyCustomerState(storage);
  const raw = await storage.getItem(customerStateKey(userId));
  if (!raw) return { cart: {}, cartRevision: '', demoRecentIds: [], demoRecentMeals: [] };
  try { return snapshotFrom(JSON.parse(raw), userId); }
  catch { return { cart: {}, cartRevision: '', demoRecentIds: [], demoRecentMeals: [] }; }
}

/** Persist only cart ownership data; profile fields, email, consent, and terms stay out of device storage. */
export async function saveCustomerLocalState(storage: Storage, userId: string | null, value: unknown) {
  await storage.setItem(customerStateKey(userId), JSON.stringify(snapshotFrom(value, userId)));
}
