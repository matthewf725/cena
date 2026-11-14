-- Lightweight, paged pickup discovery. No location data is written by this function.
alter table public.restaurants
  add column if not exists latitude double precision check(latitude is null or latitude between -90 and 90),
  add column if not exists longitude double precision check(longitude is null or longitude between -180 and 180);

create index if not exists restaurants_active_cuisine_idx on public.restaurants(lower(cuisine),name) where active;
create index if not exists restaurants_active_coordinates_idx on public.restaurants(latitude,longitude) where active;
create index if not exists pickup_slots_discovery_idx on public.pickup_slots(restaurant_id,starts_at) where active;
create index if not exists catalog_items_discovery_idx on public.catalog_items(restaurant_id,lower(name)) where active and published_at is not null;
create index if not exists slot_inventory_item_idx on public.slot_item_inventory(item_id,slot_id);

create or replace function public.discover_pickup_feed(
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_after text default null,
  p_query text default null,
  p_cuisine text default null,
  p_recent_ids uuid[] default '{}'
) returns jsonb
language plpgsql stable security invoker set search_path=public,auth as $$
declare
  v_result jsonb;
  v_query text := nullif(trim(p_query),'');
  v_cuisine text := nullif(trim(p_cuisine),'');
  v_radius double precision := 35 / 3958.7613;
  v_latitude_span double precision := degrees(v_radius);
  v_longitude_span double precision;
begin
  if (p_latitude is null) <> (p_longitude is null) then raise exception 'latitude and longitude must be provided together'; end if;
  if p_latitude is not null and (p_latitude not between -90 and 90 or p_longitude not between -180 and 180) then
    raise exception 'coordinates out of range';
  end if;
  if length(v_query)>120 or length(v_cuisine)>80 or length(p_after)>100 then raise exception 'discovery input too long'; end if;

  if p_latitude is not null and abs(p_latitude) + v_latitude_span < 90 then
    v_longitude_span := degrees(asin(least(1::double precision,sin(v_radius)/cos(radians(p_latitude)))));
  end if;

  with recent_ids as (
    select distinct on (entry.id) entry.id,entry.ordinality
    from unnest(coalesce(p_recent_ids,'{}'::uuid[])) with ordinality entry(id,ordinality)
    where entry.ordinality<=20 order by entry.id,entry.ordinality
  ), search_market as (
    select r.*
    from public.restaurants r
    where r.active and (
      p_latitude is null or
      ((r.latitude is null or r.longitude is null) and v_query is not null) or
      (r.latitude between p_latitude-v_latitude_span and p_latitude+v_latitude_span and (
        v_longitude_span is null or
        r.longitude between p_longitude-v_longitude_span and p_longitude+v_longitude_span or
        r.longitude between p_longitude-v_longitude_span-360 and p_longitude+v_longitude_span-360 or
        r.longitude between p_longitude-v_longitude_span+360 and p_longitude+v_longitude_span+360
      )) or exists(select 1 from recent_ids rec where rec.id=r.id)
    )
  ), restaurant_cards as (
    select r.id,r.slug,r.name,r.cuisine,r.image_key,r.description,r.address,r.timezone,r.curbside_enabled,
      r.latitude,r.longitude,
      case when p_latitude is null or r.latitude is null or r.longitude is null then null else round((3958.7613 * acos(least(1::double precision,greatest(-1::double precision,
        sin(radians(p_latitude))*sin(radians(r.latitude)) + cos(radians(p_latitude))*cos(radians(r.latitude))*cos(radians(r.longitude-p_longitude))
      ))))::numeric,1)::double precision end as distance_miles,
      ns.id as slot_id,ns.starts_at,ns.ends_at,ns.cutoff_at,ns.min_price_cents,
      case when ns.id is null then null else jsonb_build_object('id',ns.id,'starts_at',ns.starts_at,'ends_at',ns.ends_at,'cutoff_at',ns.cutoff_at) end as next_slot
    from search_market r
    left join lateral (
      select s.id,s.starts_at,s.ends_at,s.cutoff_at,min(ci.price_cents) as min_price_cents
      from public.pickup_slots s
      join public.slot_item_inventory inv on inv.slot_id=s.id and inv.available_qty>inv.reserved_qty
      join public.catalog_items ci on ci.id=inv.item_id and ci.restaurant_id=r.id and ci.active and ci.published_at is not null
      where s.restaurant_id=r.id and s.active and s.starts_at>now() and s.cutoff_at>now() and s.reserved_count<s.capacity
      group by s.id,s.starts_at,s.ends_at,s.cutoff_at
      order by s.starts_at,s.id limit 1
    ) ns on true
    where r.active and (v_cuisine is null or lower(r.cuisine)=lower(v_cuisine))
      and (v_query is null or r.name ilike '%'||v_query||'%' or r.description ilike '%'||v_query||'%' or r.cuisine ilike '%'||v_query||'%'
        or exists(select 1 from public.catalog_items qi join public.slot_item_inventory qinv on qinv.item_id=qi.id
          join public.pickup_slots qs on qs.id=qinv.slot_id
          where qi.restaurant_id=r.id and qi.active and qi.published_at is not null and (qi.name ilike '%'||v_query||'%' or qi.description ilike '%'||v_query||'%')
            and qinv.available_qty>qinv.reserved_qty and qs.active and qs.starts_at>now() and qs.cutoff_at>now() and qs.reserved_count<qs.capacity))
  ), cards as (
    select rc.*,
      jsonb_build_object('id',rc.id,'slug',rc.slug,'name',rc.name,'cuisine',rc.cuisine,'image_key',rc.image_key,
        'description',rc.description,'address',rc.address,'timezone',rc.timezone,'curbside_enabled',rc.curbside_enabled,
        'latitude',rc.latitude,'longitude',rc.longitude,'distance_miles',rc.distance_miles,'next_slot',rc.next_slot,
        'min_price_cents',rc.min_price_cents) as card
    from restaurant_cards rc
  ), available as (
    select * from cards where slot_id is not null
      and (p_latitude is null or distance_miles <= 35 or (distance_miles is null and v_query is not null))
  ),
  cuisine_keys as (
    select lower(r.cuisine) as cuisine_key,min(r.cuisine) as cuisine_name
    from public.restaurants r
    where r.active and (v_cuisine is null or lower(r.cuisine)=lower(v_cuisine))
      and (p_after is null or lower(r.cuisine)>lower(trim(p_after)))
      and exists(select 1 from available a where a.id=r.id)
    group by lower(r.cuisine) order by lower(r.cuisine) limit 5
  ), page_cuisines as (
    select cuisine_key,cuisine_name from cuisine_keys
  ), category_page as (
    select pc.*,row_number() over(order by pc.cuisine_key) as rail_number from page_cuisines pc
  ), category_rows as (
    select pc.cuisine_key,pc.cuisine_name,coalesce((
      select jsonb_agg(limited.card order by limited.distance_miles nulls last,limited.name,limited.id)
      from (select a.card,a.distance_miles,a.name,a.id from available a where lower(a.cuisine)=pc.cuisine_key
        order by a.distance_miles nulls last,a.name,a.id limit 8) limited
    ),'[]'::jsonb) as restaurants
    from category_page pc where pc.rail_number<=4
  ), explore_rows as (
    select candidates.id as restaurant_id,candidates.card,candidates.distance_miles,candidates.name as restaurant_name,meal.value as meal
    from (select a.* from available a order by a.distance_miles nulls last,a.name,a.id limit 8) candidates
    cross join lateral (
      select jsonb_build_object('id',ci.id,'name',ci.name,'description',ci.description,'price_cents',ci.price_cents,
        'regular_price_cents',ci.regular_price_cents,'image_key',ci.image_key,'equipment',ci.equipment,'published_steps',ci.published_steps) as value
      from public.catalog_items ci join public.slot_item_inventory inv on inv.item_id=ci.id and inv.available_qty>inv.reserved_qty
      join public.pickup_slots meal_slot on meal_slot.id=inv.slot_id and meal_slot.restaurant_id=candidates.id
        and meal_slot.active and meal_slot.starts_at>now() and meal_slot.cutoff_at>now() and meal_slot.reserved_count<meal_slot.capacity
      where ci.restaurant_id=candidates.id and ci.active and ci.published_at is not null
        and (v_query is null or candidates.name ilike '%'||v_query||'%' or candidates.description ilike '%'||v_query||'%'
          or candidates.cuisine ilike '%'||v_query||'%' or ci.name ilike '%'||v_query||'%' or ci.description ilike '%'||v_query||'%')
      order by case when meal_slot.id=candidates.slot_id then 0 else 1 end,ci.name,ci.id,meal_slot.starts_at
      limit 1
    ) meal
  ), more_cuisines as (
    select (select cuisine_key from page_cuisines order by cuisine_key offset 3 limit 1) as last_key,
      (select count(*)>4 from page_cuisines) as has_more
  )
  select jsonb_build_object(
    'nearby',case when p_after is not null then '[]'::jsonb else coalesce((select jsonb_agg(n.card order by n.distance_miles nulls last,n.name,n.id)
      from (select a.card,a.distance_miles,a.name,a.id from available a order by a.distance_miles nulls last,a.name,a.id limit 8) n),'[]'::jsonb) end,
    'explore',case when p_after is not null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('restaurant',m.card,'meal',m.meal) order by m.distance_miles nulls last,m.restaurant_name,m.restaurant_id)
      from explore_rows m),'[]'::jsonb) end,
    'recent',coalesce((select jsonb_agg(c.card order by rec.ordinality)
      from recent_ids rec
      join cards c on c.id=rec.id),'[]'::jsonb),
    'categories',coalesce((select jsonb_agg(jsonb_build_object('name',cr.cuisine_name,'restaurants',cr.restaurants) order by cr.cuisine_key) from category_rows cr),'[]'::jsonb),
    'next_cursor',case when (select has_more from more_cuisines) then (select last_key from more_cuisines) else null end
  ) into v_result;

  return v_result;
end $$;

revoke all on function public.discover_pickup_feed(double precision,double precision,text,text,text,uuid[]) from public;
grant execute on function public.discover_pickup_feed(double precision,double precision,text,text,text,uuid[]) to anon,authenticated;
