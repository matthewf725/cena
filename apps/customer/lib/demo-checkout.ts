import type { BagLine } from '../components/bag';
import type { DemoOrder } from './cal-poly-demo';
import type { Kitchen } from './data';

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

export function createDemoCheckoutDraft(
  kitchen: Kitchen, items: DemoCheckoutDraft['items'], cartRevision: string,
  slot?: NonNullable<Kitchen['pickupSlots']>[number], now = Date.now(),
): DemoCheckoutDraft {
  const hour = 60 * 60 * 1000;
  return {
    restaurantId: kitchen.backendId ?? kitchen.id,
    restaurantName: kitchen.name,
    address: kitchen.address ?? '',
    timeZone: kitchen.timezone ?? 'America/Los_Angeles',
    pickupStartsAt: slot?.startsAt ?? new Date(now + hour).toISOString(),
    pickupEndsAt: slot?.endsAt ?? new Date(now + 1.5 * hour).toISOString(),
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
