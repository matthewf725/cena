-- Optional, operator-entered local comparison. This is not checkout pricing or a derived tax field.
alter table public.catalog_items
  add column if not exists prepared_meal_total_cents integer
  check(prepared_meal_total_cents is null or prepared_meal_total_cents >= 0);

grant insert(restaurant_id,name,description,price_cents,regular_price_cents,prepared_meal_total_cents,equipment,allergens,image_key,image_url,category,active,prep_minutes)
  on public.catalog_items to authenticated;
grant update(name,description,price_cents,regular_price_cents,prepared_meal_total_cents,equipment,allergens,image_key,image_url,category,active,prep_minutes,updated_at)
  on public.catalog_items to authenticated;

-- Preserve the existing discovery contract and add only the opt-in amount to Explore meal cards.
alter function public.discover_pickup_feed(double precision,double precision,text,text,text,uuid[])
  rename to discover_pickup_feed_base;

create function public.discover_pickup_feed(
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_after text default null,
  p_query text default null,
  p_cuisine text default null,
  p_recent_ids uuid[] default '{}'
) returns jsonb
language plpgsql stable security invoker set search_path=public,auth as $$
declare v_result jsonb; v_explore jsonb;
begin
  v_result := public.discover_pickup_feed_base(p_latitude,p_longitude,p_after,p_query,p_cuisine,p_recent_ids);
  select coalesce(jsonb_agg(
    jsonb_set(e.entry,'{meal,prepared_meal_total_cents}',coalesce(to_jsonb(ci.prepared_meal_total_cents),'null'::jsonb),true)
    order by e.ordinality
  ),'[]'::jsonb) into v_explore
  from jsonb_array_elements(coalesce(v_result->'explore','[]'::jsonb)) with ordinality e(entry,ordinality)
  left join public.catalog_items ci on ci.id=(e.entry->'meal'->>'id')::uuid;
  return jsonb_set(v_result,'{explore}',v_explore,true);
end $$;

revoke all on function public.discover_pickup_feed(double precision,double precision,text,text,text,uuid[]) from public;
grant execute on function public.discover_pickup_feed(double precision,double precision,text,text,text,uuid[]) to anon,authenticated;

notify pgrst, 'reload schema';
