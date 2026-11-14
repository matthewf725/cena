export type MealOptionGroup = { id: string; name: string; min: number; max: number; choices: { id: string; name: string }[] };
export type MealSelections = Record<string, string[]>;
export type Meal = { id: string; name: string; subtitle: string; price: number; preparedMealTotalCents?: number; image: string; optionGroups?: MealOptionGroup[]; tag?: string; equipment?: string; backendItemId?: string; publishedSteps?: string[] };
export type Kitchen = { id: string; name: string; cuisine: string; rating?: string; image: string; meals: Meal[]; backendId?: string; address?:string; timezone?:string; curbsideEnabled?: boolean; latitude?: number; longitude?: number; distanceMiles?: number; pickupSlots?: { id:string; startsAt:string; endsAt:string; cutoffAt:string; remaining:Record<string,number> }[] };

export type CatalogMealRow = {
  id: string;
  name: string;
  description: string;
  price_cents: number;
  prepared_meal_total_cents?: number | null;
  image_key: string | null;
  equipment?: string[] | null;
  published_steps?: string[] | null;
  option_groups?: unknown;
};

export function mealOptionGroups(value: unknown): MealOptionGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((group): MealOptionGroup[] => {
    if (!group || typeof group.id !== 'string' || typeof group.name !== 'string'
      || !Number.isInteger(group.min) || !Number.isInteger(group.max) || group.min < 0 || group.max < group.min || !Array.isArray(group.choices)) return [];
    const choices = (group.choices as unknown[]).filter((choice): choice is MealOptionGroup['choices'][number] => !!choice && typeof choice === 'object'
      && 'id' in choice && typeof choice.id === 'string' && 'name' in choice && typeof choice.name === 'string');
    return group.max <= choices.length ? [{ id: group.id, name: group.name, min: group.min, max: group.max, choices }] : [];
  });
}

export function mealSelectionSummary(groups: MealOptionGroup[], selections: MealSelections) {
  return groups.flatMap(group => group.choices.filter(choice => selections[group.id]?.includes(choice.id)).map(choice => choice.name)).join(' · ');
}

export function normalizeMealSelections(value: unknown): MealSelections {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id);
  const groups = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(groups.flatMap(([id, choices]) => {
    if (!validId(id) || !Array.isArray(choices)) return [];
    const ids = [...new Set((choices as unknown[]).filter(validId))].sort().slice(0, 20);
    return ids.length ? [[id, ids] as const] : [];
  }).slice(0, 12));
}

export function toMeal(row: CatalogMealRow): Meal {
  const optionGroups = mealOptionGroups(row.option_groups);
  return {
    id: row.id,
    backendItemId: row.id,
    name: row.name,
    subtitle: row.description,
    price: row.price_cents / 100,
    preparedMealTotalCents: row.prepared_meal_total_cents ?? undefined,
    image: row.image_key ?? 'mediterranean',
    ...(optionGroups.length ? { optionGroups } : {}),
    equipment: row.equipment?.[0],
    publishedSteps: row.published_steps ?? [],
  };
}
