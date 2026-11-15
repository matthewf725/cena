import type { BagLine } from '../components/bag';
import type { DemoOrder } from './cal-poly-demo';

export type DemoCheckoutDraft = {
  restaurantId: string;
  restaurantName: string;
  address: string;
  timeZone: string;
  pickupStartsAt: string;
  pickupEndsAt: string;
  items: (BagLine & { key: string })[];
  subtotalCents: number;
  cartRevision: string;
  confirmationDeadline: number | null;
};

export type DemoSessionOrder = Omit<DemoOrder, 'payment_method'> & { payment_method: 'demo_checkout' };

// Bags created before the pickup address was stored can still open the seeded demo restaurants instantly.
const demoVenues: Record<string, NonNullable<BagLine['demoKitchen']>> = {
  'cal-poly-giuseppes': { name: 'Giuseppe’s Cucina Rustica', address: '849 Monterey St, San Luis Obispo, CA 93401' },
  'cal-poly-luna-red': { name: 'Luna Red', address: '1023 Chorro St, San Luis Obispo, CA 93401' },
  'cal-poly-mamas-meatball': { name: 'Mama’s Meatball', address: '570 Higuera St #130, San Luis Obispo, CA 93401' },
  'cal-poly-piadina': { name: 'Piadina', address: '877 Palm St, San Luis Obispo, CA 93401' },
};

export function createDemoCheckoutDraft(
  items: DemoCheckoutDraft['items'], cartRevision: string, now = Date.now(),
): DemoCheckoutDraft {
  const first = items[0];
  const kitchen: NonNullable<BagLine['demoKitchen']> = first.demoKitchen ?? demoVenues[first.restaurantId] ?? { name: 'Restaurant pickup' };
  const hour = 60 * 60 * 1000;
  return {
    restaurantId: kitchen.backendId ?? first.restaurantId,
    restaurantName: kitchen.name,
    address: kitchen.address ?? '',
    timeZone: kitchen.timezone ?? 'America/Los_Angeles',
    pickupStartsAt: new Date(now + hour).toISOString(),
    pickupEndsAt: new Date(now + 1.5 * hour).toISOString(),
    items,
    subtotalCents: items.reduce((total, item) => total + item.qty * Math.round(100 * item.meal.price), 0),
    cartRevision,
    confirmationDeadline: null,
  };
}

export function makeDemoSessionOrder(draft: DemoCheckoutDraft): DemoSessionOrder {
  return {
    id: `${Math.random().toString(36).slice(2, 10)}-demo-${Date.now().toString(36)}`,
    restaurant_id: draft.restaurantId,
    status: 'placed',
    payment_status: 'paid',
    payment_method: 'demo_checkout',
    subtotal_cents: draft.subtotalCents,
    total_cents: draft.subtotalCents,
    pickup_starts_at: draft.pickupStartsAt,
    pickup_ends_at: draft.pickupEndsAt,
    restaurant_timezone: draft.timeZone,
    pickup_mode: 'counter',
    restaurants: { name: draft.restaurantName, address: draft.address },
    order_items: draft.items.map(({ meal, qty, selections }) => {
      const groups = (meal.optionGroups ?? []).flatMap(group => {
        const choices = group.choices.filter(choice => selections?.[group.id]?.includes(choice.id));
        return choices.length ? [{ group_id: group.id, group_name: group.name, choices }] : [];
      });
      return {
        item_id: meal.backendItemId ?? meal.id,
        name_snapshot: meal.name,
        quantity: qty,
        prep_steps_snapshot: [...(meal.publishedSteps ?? [])],
        options_snapshot: groups.length ? [{ quantity: qty, groups }] : [],
      };
    }),
  };
}
