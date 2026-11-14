-- Database-backed meal option groups and authoritative checkout snapshots.
-- Option choices do not change price: all prices and stock remain catalog-owned.

create or replace function public.catalog_option_groups_valid(p_groups jsonb)
returns boolean
language plpgsql immutable set search_path=pg_catalog,public as $$
declare
  v_group jsonb;
  v_choice jsonb;
  v_group_id text;
  v_min text;
  v_max text;
  v_choice_count integer;
begin
  if jsonb_typeof(p_groups) is distinct from 'array' or jsonb_array_length(p_groups)>12 then return false; end if;
  if exists(select 1 from jsonb_array_elements(p_groups) g where jsonb_typeof(g) is distinct from 'object' or (select count(*) from jsonb_object_keys(g))<>5) then return false; end if;
  if exists(select 1 from jsonb_array_elements(p_groups) g where
    jsonb_typeof(g->'id') is distinct from 'string' or
    jsonb_typeof(g->'name') is distinct from 'string' or
    jsonb_typeof(g->'min') is distinct from 'number' or
    jsonb_typeof(g->'max') is distinct from 'number' or
    jsonb_typeof(g->'choices') is distinct from 'array') then return false; end if;
  if exists(select 1 from jsonb_array_elements(p_groups) g where
    (g->>'id') !~ '^[a-z0-9][a-z0-9_-]{0,63}$' or
    length(trim(g->>'name')) not between 1 and 100 or
    (g->>'min') !~ '^(0|[1-9][0-9]?)$' or
    (g->>'max') !~ '^([1-9][0-9]?)$' or
    (g->>'min')::integer>20 or (g->>'max')::integer>20 or
    (g->>'min')::integer>(g->>'max')::integer or
    jsonb_array_length(g->'choices') not between 1 and 50 or
    (g->>'max')::integer>jsonb_array_length(g->'choices')) then return false; end if;
  if (select count(*) from jsonb_array_elements(p_groups)) <>
     (select count(distinct g->>'id') from jsonb_array_elements(p_groups) g) then return false; end if;
  for v_group in select value from jsonb_array_elements(p_groups) loop
    if exists(select 1 from jsonb_array_elements(v_group->'choices') c where jsonb_typeof(c) is distinct from 'object' or (select count(*) from jsonb_object_keys(c))<>2) then return false; end if;
    if exists(select 1 from jsonb_array_elements(v_group->'choices') c where
      jsonb_typeof(c->'id') is distinct from 'string' or jsonb_typeof(c->'name') is distinct from 'string' or
      (c->>'id') !~ '^[a-z0-9][a-z0-9_-]{0,63}$' or length(trim(c->>'name')) not between 1 and 100) then return false; end if;
    if (select count(*) from jsonb_array_elements(v_group->'choices')) <>
       (select count(distinct c->>'id') from jsonb_array_elements(v_group->'choices') c) then return false; end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

alter table public.catalog_items
  add column option_groups jsonb not null default '[]'::jsonb;
alter table public.catalog_items
  add constraint catalog_items_option_groups_valid check(public.catalog_option_groups_valid(option_groups));
grant update(option_groups) on public.catalog_items to authenticated;
grant execute on function public.catalog_option_groups_valid(jsonb) to anon,authenticated;
alter table public.order_items add column options_snapshot jsonb not null default '[]'::jsonb;

-- Canonicalize client selections without trusting catalog names or prices. This makes
-- selection order irrelevant for idempotency while preserving distinct combinations.
create or replace function public.canonical_option_selections(p_selections jsonb)
returns jsonb
language plpgsql immutable set search_path=pg_catalog,public as $$
declare
  v_result jsonb;
  v_key text;
  v_value jsonb;
begin
  if p_selections is null or p_selections='null'::jsonb then return '{}'::jsonb; end if;
  if jsonb_typeof(p_selections) is distinct from 'object' then raise exception 'meal options need review'; end if;
  if (select count(*) from jsonb_each(p_selections))>12 then raise exception 'meal options need review'; end if;
  for v_key,v_value in select key,value from jsonb_each(p_selections) loop
    if v_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$' or jsonb_typeof(v_value) is distinct from 'array' or jsonb_array_length(v_value)>20 then
      raise exception 'meal options need review';
    end if;
    if exists(select 1 from jsonb_array_elements(v_value) c where jsonb_typeof(c) is distinct from 'string' or (c#>>'{}') !~ '^[a-z0-9][a-z0-9_-]{0,63}$') then
      raise exception 'meal options need review';
    end if;
    if (select count(*) from jsonb_array_elements(v_value)) <>
       (select count(distinct c#>>'{}') from jsonb_array_elements(v_value) c) then
      raise exception 'meal options need review';
    end if;
  end loop;
  select coalesce(jsonb_object_agg(k,sorted_ids order by k),'{}'::jsonb) into v_result
  from (
    select e.key k,coalesce((select jsonb_agg(c#>>'{}' order by c#>>'{}') from jsonb_array_elements(e.value) c),'[]'::jsonb) sorted_ids
    from jsonb_each(p_selections) e
  ) canonical;
  return v_result;
end;
$$;

create or replace function public.normalize_catalog_option_selections(p_groups jsonb,p_selections jsonb)
returns jsonb
language plpgsql immutable set search_path=pg_catalog,public as $$
declare
  v_canonical jsonb;
  v_group jsonb;
  v_group_id text;
  v_selected jsonb;
  v_choice_count integer;
  v_picked jsonb;
  v_result jsonb:='[]'::jsonb;
begin
  if not public.catalog_option_groups_valid(coalesce(p_groups,'[]'::jsonb)) then raise exception 'meal options need review'; end if;
  v_canonical:=public.canonical_option_selections(p_selections);
  if exists(select 1 from jsonb_object_keys(v_canonical) keys(key) where not exists(
    select 1 from jsonb_array_elements(coalesce(p_groups,'[]'::jsonb)) g where g->>'id'=keys.key)) then
    raise exception 'meal options need review';
  end if;
  for v_group in select value from jsonb_array_elements(coalesce(p_groups,'[]'::jsonb)) g order by value->>'id' loop
    v_group_id:=v_group->>'id';
    v_selected:=coalesce(v_canonical->v_group_id,'[]'::jsonb);
    v_choice_count:=jsonb_array_length(v_selected);
    if v_choice_count < (v_group->>'min')::integer or v_choice_count > (v_group->>'max')::integer then
      raise exception 'meal options need review';
    end if;
    select count(*) into v_choice_count from jsonb_array_elements(v_group->'choices') c
      where exists(select 1 from jsonb_array_elements(v_selected) s where s#>>'{}'=c->>'id');
    if v_choice_count<>jsonb_array_length(v_selected) then raise exception 'meal options need review'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',c->>'id','name',c->>'name') order by c->>'id'),'[]'::jsonb)
      into v_picked
      from jsonb_array_elements(v_group->'choices') c
      where exists(select 1 from jsonb_array_elements(v_selected) s where s#>>'{}'=c->>'id');
    if jsonb_array_length(v_picked)>0 then
      v_result:=v_result||jsonb_build_array(jsonb_build_object('group_id',v_group_id,'group_name',v_group->>'name','choices',v_picked));
    end if;
  end loop;
  return v_result;
end;
$$;
revoke all on function public.canonical_option_selections(jsonb),public.normalize_catalog_option_selections(jsonb,jsonb) from public,anon,authenticated;

-- One public write path for option editor state. RLS and the explicit membership
-- check both scope edits to the selected restaurant.
create or replace function public.save_catalog_option_groups(p_catalog_item_id uuid,p_restaurant_id uuid,p_option_groups jsonb)
returns public.catalog_items
language plpgsql security invoker set search_path=public,auth as $$
declare v_item public.catalog_items%rowtype;
begin
  if auth.uid() is null or not public.is_restaurant_member(p_restaurant_id) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  if not public.catalog_option_groups_valid(coalesce(p_option_groups,'[]'::jsonb)) then
    raise exception 'meal options need review';
  end if;
  update public.catalog_items set option_groups=coalesce(p_option_groups,'[]'::jsonb),updated_at=now()
    where id=p_catalog_item_id and restaurant_id=p_restaurant_id returning * into v_item;
  if not found then raise exception 'catalog item unavailable'; end if;
  return v_item;
end;
$$;
revoke all on function public.save_catalog_option_groups(uuid,uuid,jsonb) from public,anon;
grant execute on function public.save_catalog_option_groups(uuid,uuid,jsonb) to authenticated;

-- Legacy items without selections keep their prior request hash and checkout contract.
-- Distinct option combinations are folded into one order_items row per catalog item,
-- so all existing inventory release/refund paths continue to release the full quantity.
create or replace function public.create_order(
 p_restaurant_id uuid,p_slot_id uuid,p_idempotency_key text,p_pickup_mode text,p_vehicle jsonb,p_items jsonb
) returns public.orders language plpgsql security definer set search_path=public,auth as $$
declare
 v_uid uuid:=auth.uid(); v_slot public.pickup_slots%rowtype; v_rest public.restaurants%rowtype;
 v_order public.orders%rowtype; v_item public.catalog_items%rowtype; v_row record; v_combo record;
 v_qty integer; v_subtotal integer:=0; v_request_hash text; v_canonical_items jsonb;
 v_vehicle jsonb:='{}'::jsonb; v_option_snapshot jsonb;
begin
 if v_uid is null then raise exception 'authentication required' using errcode='42501'; end if;
 if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 8 and 128 then raise exception 'invalid idempotency key'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_uid::text||':'||p_idempotency_key,0));
 if p_pickup_mode is null or p_pickup_mode not in ('counter','curbside') then raise exception 'invalid pickup mode'; end if;
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 30 then raise exception 'order requires 1–30 items'; end if;
 if exists(select 1 from jsonb_array_elements(p_items) x where coalesce(x->>'quantity','') !~ '^[1-9][0-9]?$' or x->>'item_id' is null) then
   raise exception 'invalid item quantity or ID';
 end if;
 if p_pickup_mode='curbside' then
   if jsonb_typeof(p_vehicle) is distinct from 'object' or exists(
     select 1 from unnest(array['make','model','color']) field
     where jsonb_typeof(p_vehicle->field) is distinct from 'string' or length(trim(p_vehicle->>field)) not between 1 and 60
   ) then raise exception 'vehicle make, model, and color required'; end if;
   v_vehicle:=jsonb_build_object('make',trim(p_vehicle->>'make'),'model',trim(p_vehicle->>'model'),'color',trim(p_vehicle->>'color'));
 end if;
 select jsonb_agg(case when x.selections='{}'::jsonb
     then jsonb_build_object('item_id',x.item_id,'quantity',x.quantity)
     else jsonb_build_object('item_id',x.item_id,'quantity',x.quantity,'selections',x.selections) end
     order by x.item_id,x.selections::text)
   into v_canonical_items
 from (
   select (i->>'item_id')::uuid item_id,public.canonical_option_selections(i->'selections') selections,
     sum((i->>'quantity')::integer)::integer quantity
   from jsonb_array_elements(p_items) i group by 1,2
 ) x;
 v_request_hash:=encode(extensions.digest(convert_to(jsonb_build_object('restaurant_id',p_restaurant_id,'slot_id',p_slot_id,
   'pickup_mode',p_pickup_mode,'vehicle',v_vehicle,'items',v_canonical_items)::text,'UTF8'),'sha256'),'hex');
 select * into v_order from public.orders where user_id=v_uid and idempotency_key=p_idempotency_key;
 if found then
   if v_order.request_hash<>v_request_hash then raise exception 'idempotency key reused with different request'; end if;
   return v_order;
 end if;
 select * into v_rest from public.restaurants where id=p_restaurant_id and active;
 if not found then raise exception 'restaurant unavailable'; end if;
 if p_pickup_mode='curbside' and not v_rest.curbside_enabled then raise exception 'curbside unavailable'; end if;
 select * into v_slot from public.pickup_slots where id=p_slot_id and restaurant_id=p_restaurant_id for update;
 if not found or not v_slot.active or v_slot.starts_at<=clock_timestamp() or v_slot.cutoff_at<=clock_timestamp() then raise exception 'pickup slot closed'; end if;
 if v_slot.reserved_count>=v_slot.capacity then raise exception 'pickup slot full'; end if;
 -- Lock each catalog and inventory row once, and validate every distinct combo against current options.
 for v_row in select (i->>'item_id')::uuid item_id,sum((i->>'quantity')::integer)::integer quantity
   from jsonb_array_elements(p_items) i group by 1 order by 1 loop
   v_qty:=v_row.quantity;
   if v_qty<1 or v_qty>50 then raise exception 'invalid item quantity'; end if;
   select * into v_item from public.catalog_items where id=v_row.item_id and restaurant_id=p_restaurant_id and active and published_at is not null for share;
   if not found then raise exception 'menu item unavailable'; end if;
   for v_combo in select distinct public.canonical_option_selections(i->'selections') selections
     from jsonb_array_elements(p_items) i where (i->>'item_id')::uuid=v_item.id loop
     perform public.normalize_catalog_option_selections(v_item.option_groups,v_combo.selections);
   end loop;
   perform 1 from public.slot_item_inventory where slot_id=p_slot_id and item_id=v_item.id for update;
   if not found then raise exception 'item unavailable for selected slot'; end if;
   if (select available_qty-reserved_qty from public.slot_item_inventory where slot_id=p_slot_id and item_id=v_item.id)<v_qty then raise exception 'item out of stock'; end if;
   v_subtotal:=v_subtotal+v_item.price_cents*v_qty;
 end loop;
 insert into public.orders(user_id,restaurant_id,slot_id,idempotency_key,request_hash,pickup_starts_at,pickup_ends_at,restaurant_timezone,pickup_mode,vehicle,subtotal_cents)
 values(v_uid,p_restaurant_id,p_slot_id,p_idempotency_key,v_request_hash,v_slot.starts_at,v_slot.ends_at,v_rest.timezone,p_pickup_mode,v_vehicle,v_subtotal)
 returning * into v_order;
 for v_row in select (i->>'item_id')::uuid item_id,sum((i->>'quantity')::integer)::integer quantity
   from jsonb_array_elements(p_items) i group by 1 order by 1 loop
   select * into v_item from public.catalog_items where id=v_row.item_id and restaurant_id=p_restaurant_id;
   select coalesce(jsonb_agg(jsonb_build_object('quantity',combo.quantity,'groups',combo.groups) order by combo.selections::text)
       filter(where combo.groups<>'[]'::jsonb),'[]'::jsonb)
     into v_option_snapshot
   from (
     select public.canonical_option_selections(i->'selections') selections,
       sum((i->>'quantity')::integer)::integer quantity,
       public.normalize_catalog_option_selections(v_item.option_groups,public.canonical_option_selections(i->'selections')) groups
     from jsonb_array_elements(p_items) i where (i->>'item_id')::uuid=v_item.id
     group by 1
   ) combo;
   insert into public.order_items(order_id,item_id,name_snapshot,unit_price_cents,quantity,prep_steps_snapshot,options_snapshot)
   values(v_order.id,v_item.id,v_item.name,v_item.price_cents,v_row.quantity,v_item.published_steps,v_option_snapshot);
   update public.slot_item_inventory set reserved_qty=reserved_qty+v_row.quantity where slot_id=p_slot_id and item_id=v_item.id;
 end loop;
 update public.pickup_slots set reserved_count=reserved_count+1 where id=p_slot_id;
 insert into public.analytics_events(user_id,restaurant_id,event_type,payload)
 values(v_uid,p_restaurant_id,'order_placed',jsonb_build_object('order_id',v_order.id,'subtotal_cents',v_subtotal));
 return v_order;
end;
$$;

create or replace function public.quote_checkout_order(
 p_user_id uuid,p_restaurant_id uuid,p_slot_id uuid,p_items jsonb,p_promo_code text
) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare
 v_code text:=nullif(upper(trim(coalesce(p_promo_code,''))),''); v_pct integer; v_subtotal bigint:=0;
 v_discount bigint:=0; v_total bigint; v_slot public.pickup_slots%rowtype; v_account public.restaurant_payment_accounts%rowtype;
 v_item public.catalog_items%rowtype; v_row record; v_combo record; v_promo public.restaurant_promotions%rowtype;
begin
 if p_user_id is null or not exists(select 1 from auth.users where id=p_user_id) then raise exception 'authentication required' using errcode='42501'; end if;
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 30 or
    exists(select 1 from jsonb_array_elements(p_items) i where coalesce(i->>'quantity','') !~ '^[1-9][0-9]?$' or i->>'item_id' is null) then
   raise exception 'invalid checkout items';
 end if;
 if v_code is not null and v_code !~ '^[A-Z0-9][A-Z0-9_-]{2,31}$' then raise exception 'invalid promo code'; end if;
 if not exists(select 1 from public.restaurants r where r.id=p_restaurant_id and r.active) then raise exception 'restaurant unavailable'; end if;
 select * into v_slot from public.pickup_slots where id=p_slot_id and restaurant_id=p_restaurant_id and active
   and starts_at>clock_timestamp()+interval '32 minutes' and cutoff_at>clock_timestamp();
 if not found then raise exception 'pickup slot closed'; end if;
 if v_slot.reserved_count>=v_slot.capacity then raise exception 'pickup slot full'; end if;
 for v_row in select (i->>'item_id')::uuid item_id,sum((i->>'quantity')::integer)::integer quantity
   from jsonb_array_elements(p_items) i group by 1 order by 1 loop
   if v_row.quantity not between 1 and 50 then raise exception 'invalid item quantity'; end if;
   select * into v_item from public.catalog_items c where c.id=v_row.item_id and c.restaurant_id=p_restaurant_id and c.active and c.published_at is not null;
   if not found then raise exception 'menu item unavailable'; end if;
   for v_combo in select distinct public.canonical_option_selections(i->'selections') selections
     from jsonb_array_elements(p_items) i where (i->>'item_id')::uuid=v_item.id loop
     perform public.normalize_catalog_option_selections(v_item.option_groups,v_combo.selections);
   end loop;
   if not exists(select 1 from public.slot_item_inventory inv where inv.slot_id=p_slot_id and inv.item_id=v_item.id
     and inv.available_qty-inv.reserved_qty>=v_row.quantity) then raise exception 'menu item unavailable for selected slot'; end if;
   v_subtotal:=v_subtotal+v_item.price_cents::bigint*v_row.quantity;
   if v_subtotal>2147483647 then raise exception 'order total exceeds supported amount'; end if;
 end loop;
 if v_code is not null then
   select * into v_promo from public.restaurant_promotions p where p.restaurant_id=p_restaurant_id and p.code=v_code
     and p.active and p.starts_at<=clock_timestamp() and (p.ends_at is null or p.ends_at>clock_timestamp())
     and (p.max_redemptions is null or p.reserved_redemptions+p.redeemed_count<p.max_redemptions);
   if not found then raise exception 'promo code is unavailable'; end if;
   v_pct:=v_promo.discount_percent; v_discount:=(v_subtotal*v_pct+50)/100;
 end if;
 v_total:=v_subtotal-v_discount;
 select * into v_account from public.restaurant_payment_accounts a where a.restaurant_id=p_restaurant_id and a.charges_enabled and a.payouts_enabled;
 if not found then raise exception 'restaurant payments are not enabled'; end if;
 if v_total<v_account.application_fee_cents then raise exception 'order total is below the platform fee'; end if;
 return jsonb_build_object('restaurant_id',p_restaurant_id,'slot_id',p_slot_id,'subtotal_cents',v_subtotal,'discount_cents',v_discount,
   'amount_cents',v_total,'currency','usd','promo_code',v_code,'discount_percent',v_pct);
end;
$$;

revoke all on function public.create_order(uuid,uuid,text,text,jsonb,jsonb) from public,anon;
revoke all on function public.quote_checkout_order(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.quote_checkout_order(uuid,uuid,uuid,jsonb,text) to service_role;
notify pgrst,'reload schema';
