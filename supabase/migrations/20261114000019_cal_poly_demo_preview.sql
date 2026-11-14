-- Public, read-only preview for the fixed Cal Poly customer demo account.
-- This intentionally returns a small allowlisted projection; it never exposes
-- customer identifiers or arbitrary profile fields.
create or replace function public.get_cal_poly_demo()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public,auth
as $$
declare
  v_demo_user_id uuid;
  v_display_name text;
  v_equipment text[];
  v_orders jsonb;
  v_upcoming jsonb;
begin
  -- Pin the public preview to the one provisioned demo Auth identity. The Auth
  -- email is used only as an internal lookup key and is never returned.
  select u.id into v_demo_user_id
  from auth.users u
  where lower(u.email)='demo-calpoly-customer@cena.test'
    and u.raw_user_meta_data->>'cena_demo'='cal-poly'
  limit 1;
  if v_demo_user_id is null then
    raise no_data_found using message='Cal Poly demo account is unavailable';
  end if;

  select case
      when length(trim(p.display_name)) between 1 and 60 then trim(p.display_name)
      else null
    end,
    coalesce(array_agg(equipment_label order by equipment_label)
      filter(where equipment_label is not null),'{}'::text[])
  into v_display_name,v_equipment
  from public.profiles p
  left join lateral unnest(coalesce(p.equipment,'{}'::text[])) as equipment_values(equipment_label) on true
  where p.id=v_demo_user_id
  group by p.display_name;
  if v_display_name is null then
    raise no_data_found using message='Cal Poly demo profile is unavailable';
  end if;

  -- The profile is a demo fixture; still whitelist equipment labels so public
  -- anonymous reads cannot surface unrelated free-form profile text.
  select coalesce(array_agg(label order by label),'{}'::text[])
  into v_equipment
  from unnest(coalesce(v_equipment,'{}'::text[])) label
  where label=any(array['Oven','Stovetop','Microwave','Air fryer','Toaster','Panini press']::text[]);

  select jsonb_build_object(
    'id',o.id::text,
    'restaurant_id',r.id::text,
    'status',o.status,
    'payment_status','pay_at_pickup',
    'payment_method','pay_at_pickup',
    'subtotal_cents',o.subtotal_cents,
    'pickup_starts_at',o.pickup_starts_at,
    'pickup_ends_at',o.pickup_ends_at,
    'restaurant_timezone',r.timezone,
    'pickup_mode','counter',
    'restaurants',jsonb_build_object('name',r.name,'address',r.address),
    'order_items',coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id',oi.item_id::text,
        'name_snapshot',oi.name_snapshot,
        'quantity',oi.quantity,
        'unit_price_cents',oi.unit_price_cents,
        'prep_steps_snapshot',oi.prep_steps_snapshot,
        'options_snapshot',oi.options_snapshot
      ) order by oi.id)
      from public.order_items oi where oi.order_id=o.id
    ),'[]'::jsonb)
  ) into v_upcoming
  from public.orders o
  join public.restaurants r on r.id=o.restaurant_id
  where o.user_id=v_demo_user_id
    and o.request_hash='cal-poly-demo'
    and o.payment_method='pay_at_pickup'
    and o.status in ('placed','accepted','preparing','ready')
    and o.pickup_ends_at>now()
    and r.slug in ('cal-poly-luna-red','cal-poly-mamas-meatball','cal-poly-piadina','cal-poly-giuseppes')
  order by o.pickup_starts_at,o.created_at
  limit 1;

  select coalesce(jsonb_agg(row_data.payload order by row_data.pickup_starts_at desc),'[]'::jsonb)
  into v_orders
  from (
    select o.pickup_starts_at,
      jsonb_build_object(
        'id',o.id::text,
        'restaurant_id',r.id::text,
        'status',o.status,
        'payment_status','pay_at_pickup',
        'payment_method','pay_at_pickup',
        'subtotal_cents',o.subtotal_cents,
        'pickup_starts_at',o.pickup_starts_at,
        'pickup_ends_at',o.pickup_ends_at,
        'restaurant_timezone',r.timezone,
        'pickup_mode','counter',
        'restaurants',jsonb_build_object('name',r.name,'address',r.address),
        'order_items',coalesce((
          select jsonb_agg(jsonb_build_object(
            'item_id',oi.item_id::text,
            'name_snapshot',oi.name_snapshot,
            'quantity',oi.quantity,
            'unit_price_cents',oi.unit_price_cents,
            'prep_steps_snapshot',oi.prep_steps_snapshot,
            'options_snapshot',oi.options_snapshot
          ) order by oi.id)
          from public.order_items oi where oi.order_id=o.id
        ),'[]'::jsonb)
      ) as payload
    from public.orders o
    join public.restaurants r on r.id=o.restaurant_id
    where o.user_id=v_demo_user_id
      and o.request_hash='cal-poly-demo'
      and o.payment_method='pay_at_pickup'
      and o.status in ('placed','accepted','preparing','ready','completed')
      and r.slug in ('cal-poly-luna-red','cal-poly-mamas-meatball','cal-poly-piadina','cal-poly-giuseppes')
    order by o.pickup_starts_at desc,o.created_at desc
    limit 20
  ) row_data;

  return jsonb_build_object(
    'profile',jsonb_build_object('display_name',v_display_name,'equipment',to_jsonb(v_equipment)),
    'pickup_area',jsonb_build_object('label','1 Grand Ave, San Luis Obispo','latitude',35.2993,'longitude',-120.6599),
    'upcoming_pickup',v_upcoming,
    'orders',coalesce(v_orders,'[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_cal_poly_demo() from public,anon,authenticated;
grant execute on function public.get_cal_poly_demo() to anon,authenticated;

notify pgrst, 'reload schema';
