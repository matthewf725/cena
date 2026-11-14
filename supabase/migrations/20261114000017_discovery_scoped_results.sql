-- Server-scoped Home filters. This returns restaurants only when a matching
-- live pickup slot has matching, published catalog inventory.
create or replace function public.discover_pickup_results(
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_max_price_cents integer default null,
  p_offers_only boolean default false,
  p_same_day_only boolean default false,
  p_cuisine text default null,
  p_query text default null,
  p_limit integer default 24,
  p_offset integer default 0
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
  if p_max_price_cents is not null and p_max_price_cents not between 1 and 1000000 then raise exception 'invalid maximum price'; end if;
  if p_limit not between 1 and 50 or p_offset not between 0 and 10000 then raise exception 'invalid discovery page'; end if;
  if length(v_query)>120 or length(v_cuisine)>80 then raise exception 'discovery input too long'; end if;

  if p_latitude is not null and abs(p_latitude) + v_latitude_span < 90 then
    v_longitude_span := degrees(asin(least(1::double precision,sin(v_radius)/cos(radians(p_latitude)))));
  end if;

  with eligible as (
    select r.id,r.slug,r.name,r.cuisine,r.image_key,r.description,r.address,r.timezone,r.curbside_enabled,
      r.latitude,r.longitude,s.id as slot_id,s.starts_at,s.ends_at,s.cutoff_at,
      min(ci.price_cents) as min_price_cents
    from public.restaurants r
    join public.pickup_slots s on s.restaurant_id=r.id and s.active and s.starts_at>now()
      and s.cutoff_at>now() and s.reserved_count<s.capacity
    join public.slot_item_inventory inv on inv.slot_id=s.id and inv.available_qty>inv.reserved_qty
    join public.catalog_items ci on ci.id=inv.item_id and ci.restaurant_id=r.id
      and ci.active and ci.published_at is not null
    where r.active
      and (v_cuisine is null or lower(r.cuisine)=lower(v_cuisine))
      and (p_max_price_cents is null or ci.price_cents<=p_max_price_cents)
      and (not p_offers_only or coalesce(ci.regular_price_cents,ci.price_cents)>ci.price_cents)
      and (not p_same_day_only or (s.starts_at at time zone r.timezone)::date=(now() at time zone r.timezone)::date)
      and (v_query is null or r.name ilike '%'||v_query||'%' or r.description ilike '%'||v_query||'%'
        or r.cuisine ilike '%'||v_query||'%' or ci.name ilike '%'||v_query||'%' or ci.description ilike '%'||v_query||'%')
      and (p_latitude is null or (r.latitude is not null and r.longitude is not null and
        r.latitude between p_latitude-v_latitude_span and p_latitude+v_latitude_span and
        (v_longitude_span is null or r.longitude between p_longitude-v_longitude_span and p_longitude+v_longitude_span
          or r.longitude between p_longitude-v_longitude_span-360 and p_longitude+v_longitude_span-360
          or r.longitude between p_longitude-v_longitude_span+360 and p_longitude+v_longitude_span+360)))
    group by r.id,r.slug,r.name,r.cuisine,r.image_key,r.description,r.address,r.timezone,r.curbside_enabled,
      r.latitude,r.longitude,s.id,s.starts_at,s.ends_at,s.cutoff_at
  ), next_slots as (
    select e.*,row_number() over(partition by e.id order by e.starts_at,e.slot_id) as slot_rank,
      case when p_latitude is null then null else round((3958.7613 * acos(least(1::double precision,greatest(-1::double precision,
        sin(radians(p_latitude))*sin(radians(e.latitude)) + cos(radians(p_latitude))*cos(radians(e.latitude))*cos(radians(e.longitude-p_longitude))
      ))))::numeric,1)::double precision end as distance_miles
    from eligible e
  ), cards as (
    select jsonb_build_object('id',n.id,'slug',n.slug,'name',n.name,'cuisine',n.cuisine,'image_key',n.image_key,
      'description',n.description,'address',n.address,'timezone',n.timezone,'curbside_enabled',n.curbside_enabled,
      'latitude',n.latitude,'longitude',n.longitude,'distance_miles',n.distance_miles,
      'next_slot',jsonb_build_object('id',n.slot_id,'starts_at',n.starts_at,'ends_at',n.ends_at,'cutoff_at',n.cutoff_at),
      'min_price_cents',n.min_price_cents) as card,
      n.distance_miles,n.name,n.id
    from next_slots n where n.slot_rank=1
  ), ranked as (
    select c.card,row_number() over(order by c.distance_miles nulls last,c.name,c.id) as row_number
    from cards c
  ), windowed as (
    select * from ranked where row_number>p_offset and row_number<=p_offset+p_limit+1
  )
  select jsonb_build_object(
    'results',coalesce((select jsonb_agg(w.card order by w.row_number) from windowed w where w.row_number<=p_offset+p_limit),'[]'::jsonb),
    'has_more',exists(select 1 from windowed w where w.row_number>p_offset+p_limit),
    'next_offset',case when exists(select 1 from windowed w where w.row_number>p_offset+p_limit) then p_offset+p_limit else null end
  ) into v_result;

  return v_result;
end $$;

revoke all on function public.discover_pickup_results(double precision,double precision,integer,boolean,boolean,text,text,integer,integer) from public;
grant execute on function public.discover_pickup_results(double precision,double precision,integer,boolean,boolean,text,text,integer,integer) to anon,authenticated;
