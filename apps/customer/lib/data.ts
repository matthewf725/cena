export type Meal = { id: string; name: string; subtitle: string; price: number; preparedMealTotalCents?: number; image: string; tag?: string; equipment?: string; backendItemId?: string; publishedSteps?: string[] };
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
};

export function toMeal(row: CatalogMealRow): Meal {
  return {
    id: row.id,
    backendItemId: row.id,
    name: row.name,
    subtitle: row.description,
    price: row.price_cents / 100,
    preparedMealTotalCents: row.prepared_meal_total_cents ?? undefined,
    image: row.image_key ?? 'mediterranean',
    equipment: row.equipment?.[0],
    publishedSteps: row.published_steps ?? [],
  };
}
