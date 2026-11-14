-- Cena initial backend. Prices are integer cents; all operational times are timestamptz.
create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '', phone text, equipment text[] not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.user_equipment (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null, label text not null, details jsonb not null default '{}', created_at timestamptz not null default now()
);
create table public.consent_records (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  consent_type text not null, policy_version text not null, consent_action text not null check(consent_action in ('granted','revoked')),
  created_at timestamptz not null default now()
);

create table public.restaurants (
  id uuid primary key default gen_random_uuid(), slug text not null unique, name text not null,
  description text not null default '', cuisine text not null default 'Cafe', image_key text, timezone text not null default 'America/Los_Angeles',
  address text not null default '', phone text, curbside_enabled boolean not null default true,
  active boolean not null default true, created_at timestamptz not null default now()
);
create table public.merchant_memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  role text not null check (role in ('owner','manager','staff')),
  created_at timestamptz not null default now(), primary key(user_id,restaurant_id)
);
create table public.catalog_items (
  id uuid primary key default gen_random_uuid(), restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null, description text not null default '', price_cents integer not null check(price_cents >= 0), regular_price_cents integer check(regular_price_cents is null or regular_price_cents >= price_cents),
  equipment text[] not null default '{}', allergens text[] not null default '{}', published_steps text[] not null default '{}',
  image_key text, image_url text, category text not null default 'Menu', active boolean not null default true,
  prep_minutes integer not null default 10 check(prep_minutes between 0 and 240),
  published_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index catalog_items_id_restaurant_idx on public.catalog_items(id,restaurant_id);
create table public.prep_drafts (
  id uuid primary key default gen_random_uuid(), restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  catalog_item_id uuid references public.catalog_items(id) on delete cascade,
  name text not null, description text not null default '', price_cents integer not null default 0 check(price_cents >= 0),
  source_steps text[] not null default '{}', generated_steps text[] not null default '{}',
  image_key text, image_url text, category text not null default 'Menu', active boolean not null default true,
  updated_by uuid references auth.users(id), updated_at timestamptz not null default now(),
  constraint prep_drafts_catalog_same_restaurant_fk foreign key(catalog_item_id,restaurant_id) references public.catalog_items(id,restaurant_id) on delete cascade
);
create unique index prep_drafts_one_per_item_idx on public.prep_drafts(catalog_item_id) where catalog_item_id is not null;
create table public.pickup_slots (
  id uuid primary key default gen_random_uuid(), restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  starts_at timestamptz not null, ends_at timestamptz not null, cutoff_at timestamptz not null,
  capacity integer not null check(capacity >= 0), reserved_count integer not null default 0 check(reserved_count >= 0),
  active boolean not null default true, check(ends_at > starts_at), check(cutoff_at <= starts_at), check(reserved_count <= capacity),
  unique(restaurant_id, starts_at)
);
create table public.slot_item_inventory (
  slot_id uuid not null references public.pickup_slots(id) on delete cascade,
  item_id uuid not null references public.catalog_items(id) on delete cascade,
  available_qty integer not null check(available_qty >= 0), reserved_qty integer not null default 0 check(reserved_qty >= 0),
  primary key(slot_id,item_id), check(reserved_qty <= available_qty)
);
create or replace function public.validate_slot_inventory_restaurant() returns trigger language plpgsql set search_path=public as $$
declare sr uuid; ir uuid;
begin
 select restaurant_id into sr from public.pickup_slots where id=new.slot_id;
 select restaurant_id into ir from public.catalog_items where id=new.item_id;
 if sr is null or ir is null or sr <> ir then raise exception 'slot and item must belong to the same restaurant'; end if;
 return new;
end $$;
create trigger slot_inventory_restaurant_guard before insert or update of slot_id,item_id on public.slot_item_inventory
for each row execute function public.validate_slot_inventory_restaurant();

create or replace function public.touch_prep_draft_updated_at() returns trigger language plpgsql set search_path=public as $$
begin new.updated_at := clock_timestamp(); return new; end $$;
create trigger prep_draft_touch_updated_at before update on public.prep_drafts for each row execute function public.touch_prep_draft_updated_at();

create or replace function public.protect_booked_slot_schedule() returns trigger language plpgsql set search_path=public as $$
begin
 if (new.starts_at,new.ends_at,new.cutoff_at,new.restaurant_id) is distinct from (old.starts_at,old.ends_at,old.cutoff_at,old.restaurant_id)
   and exists(select 1 from public.orders o where o.slot_id=old.id) then raise exception 'cannot reschedule a slot with orders'; end if;
 return new;
end $$;
create table public.orders (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
  restaurant_id uuid not null references public.restaurants(id), slot_id uuid not null references public.pickup_slots(id),
  idempotency_key text not null, status text not null default 'placed' check(status in ('placed','accepted','preparing','ready','completed','cancelled')),
  request_hash text not null,
  pickup_starts_at timestamptz not null, pickup_ends_at timestamptz not null, restaurant_timezone text not null,
  pickup_mode text not null default 'counter' check(pickup_mode in ('counter','curbside')),
  vehicle jsonb not null default '{}', subtotal_cents integer not null check(subtotal_cents >= 0),
  payment_method text not null default 'pay_at_pickup' check(payment_method = 'pay_at_pickup'),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,idempotency_key)
);
create trigger protect_booked_slot_schedule before update of starts_at,ends_at,cutoff_at,restaurant_id on public.pickup_slots
for each row execute function public.protect_booked_slot_schedule();
create table public.order_items (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete cascade,
  item_id uuid not null references public.catalog_items(id), name_snapshot text not null,
  unit_price_cents integer not null check(unit_price_cents >= 0), quantity integer not null check(quantity between 1 and 50)
);
create index orders_user_created_idx on public.orders(user_id,created_at desc);
create index orders_merchant_created_idx on public.orders(restaurant_id,created_at desc);
create unique index catalog_items_restaurant_name_idx on public.catalog_items(restaurant_id,lower(name));

create table public.analytics_events (
  id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete set null,
  restaurant_id uuid references public.restaurants(id) on delete set null, event_type text not null,
  payload jsonb not null default '{}', created_at timestamptz not null default now()
);
create index analytics_events_date_idx on public.analytics_events(created_at desc);
create table public.waitlist_entries (
  id uuid primary key default gen_random_uuid(), email text not null, name text, role text not null default 'customer' check(role in ('customer','restaurant_owner','merchant')), source text not null default 'app',
  created_at timestamptz not null default now()
);
create unique index waitlist_email_lower_idx on public.waitlist_entries(lower(email));
create table public.privacy_requests (
  id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete set null,
  email text not null, request_type text not null check(request_type in ('access','export','delete','rectify')),
  details text not null default '' check(length(details)<=2000), status text not null default 'received' check(status in ('received','processing','completed','rejected')),
  created_at timestamptz not null default now(), resolved_at timestamptz
);

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin
 insert into public.profiles(id,display_name) values(new.id,coalesce(new.raw_user_meta_data->>'display_name','')) on conflict(id) do nothing;
 return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.is_restaurant_member(rid uuid) returns boolean
language sql stable security definer set search_path=public,auth as $$
 select exists(select 1 from public.merchant_memberships m where m.restaurant_id=rid and m.user_id=auth.uid())
$$;
create or replace function public.is_operator() returns boolean language sql stable as $$
 select coalesce(auth.jwt()->'app_metadata'->>'role','') in ('operator','admin')
$$;

-- Customer order contract: items is [{"item_id":uuid,"quantity":int}]. All price/stock checks
-- and reservations happen under row locks; an identical key always returns the original order.
create or replace function public.create_order(
 p_restaurant_id uuid, p_slot_id uuid, p_idempotency_key text, p_pickup_mode text,
 p_vehicle jsonb, p_items jsonb
) returns public.orders language plpgsql security definer set search_path=public,auth as $$
declare v_uid uuid := auth.uid(); v_slot public.pickup_slots%rowtype; v_rest public.restaurants%rowtype;
 v_order public.orders%rowtype; v_subtotal integer := 0; v_row record; v_item public.catalog_items%rowtype;
 v_qty integer; v_request_hash text; v_canonical_items jsonb;
begin
 if v_uid is null then raise exception 'authentication required' using errcode='42501'; end if;
 if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 8 and 128 then raise exception 'invalid idempotency key'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_uid::text||':'||p_idempotency_key,0));
 if p_pickup_mode not in ('counter','curbside') then raise exception 'invalid pickup mode'; end if;
 if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items)=0 then raise exception 'order requires items'; end if;
 select jsonb_agg(jsonb_build_object('item_id',x.item_id,'quantity',x.quantity) order by x.item_id) into v_canonical_items
 from (select (x->>'item_id')::uuid item_id,sum((x->>'quantity')::int)::int quantity from jsonb_array_elements(p_items) x group by 1) x;
 v_request_hash := encode(extensions.digest(convert_to(jsonb_build_object('restaurant_id',p_restaurant_id,'slot_id',p_slot_id,
   'pickup_mode',p_pickup_mode,'vehicle',case when p_pickup_mode='curbside' then coalesce(p_vehicle,'{}'::jsonb) else '{}'::jsonb end,
   'items',v_canonical_items)::text,'UTF8'),'sha256'),'hex');
 select * into v_order from public.orders where user_id=v_uid and idempotency_key=p_idempotency_key;
 if found then
   if v_order.request_hash <> v_request_hash then raise exception 'idempotency key reused with different request'; end if;
   return v_order;
 end if;
 select * into v_rest from public.restaurants where id=p_restaurant_id and active;
 if not found then raise exception 'restaurant unavailable'; end if;
 if p_pickup_mode='curbside' then
   if not v_rest.curbside_enabled then raise exception 'curbside unavailable'; end if;
   if coalesce(trim(p_vehicle->>'make'),'')='' or coalesce(trim(p_vehicle->>'model'),'')='' or coalesce(trim(p_vehicle->>'color'),'')='' then raise exception 'vehicle make, model, and color required'; end if;
 end if;
 select * into v_slot from public.pickup_slots where id=p_slot_id and restaurant_id=p_restaurant_id for update;
 if not found or not v_slot.active or v_slot.starts_at <= clock_timestamp() or v_slot.cutoff_at <= clock_timestamp() then raise exception 'pickup slot closed'; end if;
 if v_slot.reserved_count >= v_slot.capacity then raise exception 'pickup slot full'; end if;
 -- Lock inventory rows in UUID order to avoid deadlocks, validate and compute authoritative totals.
 for v_row in select (x->>'item_id')::uuid item_id, sum((x->>'quantity')::int)::int quantity
   from jsonb_array_elements(p_items) x group by 1 order by 1 loop
   v_qty := v_row.quantity;
   if v_qty < 1 or v_qty > 50 then raise exception 'invalid item quantity'; end if;
   select * into v_item from public.catalog_items where id=v_row.item_id and restaurant_id=p_restaurant_id and active and published_at is not null;
   if not found then raise exception 'menu item unavailable'; end if;
   perform 1 from public.slot_item_inventory where slot_id=p_slot_id and item_id=v_item.id for update;
   if not found then raise exception 'item unavailable for selected slot'; end if;
   if (select available_qty-reserved_qty from public.slot_item_inventory where slot_id=p_slot_id and item_id=v_item.id) < v_qty then raise exception 'item out of stock'; end if;
   v_subtotal := v_subtotal + v_item.price_cents*v_qty;
 end loop;
 insert into public.orders(user_id,restaurant_id,slot_id,idempotency_key,request_hash,pickup_starts_at,pickup_ends_at,restaurant_timezone,pickup_mode,vehicle,subtotal_cents)
 values(v_uid,p_restaurant_id,p_slot_id,p_idempotency_key,v_request_hash,v_slot.starts_at,v_slot.ends_at,v_rest.timezone,p_pickup_mode,case when p_pickup_mode='curbside' then p_vehicle else '{}'::jsonb end,v_subtotal)
 returning * into v_order;
 for v_row in select (x->>'item_id')::uuid item_id, sum((x->>'quantity')::int)::int quantity
   from jsonb_array_elements(p_items) x group by 1 order by 1 loop
   select * into v_item from public.catalog_items where id=v_row.item_id;
   insert into public.order_items(order_id,item_id,name_snapshot,unit_price_cents,quantity)
   values(v_order.id,v_item.id,v_item.name,v_item.price_cents,v_row.quantity);
   update public.slot_item_inventory set reserved_qty=reserved_qty+v_row.quantity where slot_id=p_slot_id and item_id=v_item.id;
 end loop;
 update public.pickup_slots set reserved_count=reserved_count+1 where id=p_slot_id;
 insert into public.analytics_events(user_id,restaurant_id,event_type,payload)
 values(v_uid,p_restaurant_id,'order_placed',jsonb_build_object('order_id',v_order.id,'subtotal_cents',v_subtotal));
 return v_order;
end $$;

create or replace function public.update_order_status(p_order_id uuid,p_status text) returns public.orders
language plpgsql security definer set search_path=public,auth as $$
declare v_order public.orders%rowtype;
begin
 if p_status not in ('accepted','preparing','ready','completed','cancelled') then raise exception 'invalid status'; end if;
 select * into v_order from public.orders where id=p_order_id for update;
 if not found or not public.is_restaurant_member(v_order.restaurant_id) then raise exception 'not authorized' using errcode='42501'; end if;
 if v_order.status in ('completed','cancelled') then raise exception 'order is final'; end if;
 if p_status='cancelled' and v_order.status <> 'placed' then raise exception 'cannot cancel after acceptance'; end if;
 if p_status <> 'cancelled' and not ((v_order.status='placed' and p_status='accepted') or
   (v_order.status='accepted' and p_status='preparing') or (v_order.status='preparing' and p_status='ready') or
   (v_order.status='ready' and p_status='completed')) then raise exception 'invalid order status transition'; end if;
 update public.orders set status=p_status,updated_at=now() where id=p_order_id returning * into v_order;
 if p_status='cancelled' then
   update public.pickup_slots set reserved_count=greatest(0,reserved_count-1) where id=v_order.slot_id;
   update public.slot_item_inventory i set reserved_qty=greatest(0,i.reserved_qty-x.quantity)
   from public.order_items x where x.order_id=p_order_id and i.slot_id=v_order.slot_id and i.item_id=x.item_id;
 end if;
 return v_order;
end $$;

create or replace function public.track_event(p_event_type text,p_restaurant_id uuid default null,p_payload jsonb default '{}')
returns uuid language plpgsql security definer set search_path=public,auth as $$
declare v_id uuid;
begin
 if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
 if p_event_type not in ('restaurant_view','menu_view','item_view','search','order_placed','order_completed') then raise exception 'unsupported event'; end if;
 if coalesce((select c.consent_action from public.consent_records c where c.user_id=auth.uid() and c.consent_type='analytics' order by c.created_at desc,c.id desc limit 1),'revoked') <> 'granted' then raise exception 'analytics consent required'; end if;
 insert into public.analytics_events(user_id,restaurant_id,event_type,payload) values(auth.uid(),p_restaurant_id,p_event_type,coalesce(p_payload,'{}')) returning id into v_id;
 return v_id;
end $$;

create or replace function public.join_waitlist(p_email text,p_role text default 'customer') returns void
language plpgsql security definer set search_path=public,auth as $$
begin
 if length(trim(coalesce(p_email,''))) not between 5 and 320 or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'valid email required'; end if;
 if p_role not in ('customer','restaurant_owner','merchant') then raise exception 'invalid role'; end if;
 insert into public.waitlist_entries(email,role) values(lower(trim(p_email)),p_role)
 on conflict (lower(email)) do nothing;
 return;
end $$;

-- Publishing is an explicit merchant action with an optimistic concurrency check.
-- Draft/source steps remain private; only approved generated steps reach the public catalog.
create or replace function public.publish_prep_draft(p_draft_id uuid,p_expected_updated_at timestamptz,p_reviewed_steps text[])
returns public.catalog_items language plpgsql security definer set search_path=public,auth as $$
declare d public.prep_drafts%rowtype; i public.catalog_items%rowtype;
begin
 select * into d from public.prep_drafts where id=p_draft_id for update;
 if not found or not exists(select 1 from public.merchant_memberships m where m.restaurant_id=d.restaurant_id and m.user_id=auth.uid() and m.role in ('owner','manager')) then
   raise exception 'not authorized' using errcode='42501';
 end if;
 if d.updated_at is distinct from p_expected_updated_at then raise exception 'draft changed; reload before publishing'; end if;
 if cardinality(coalesce(p_reviewed_steps,'{}'::text[]))=0 then raise exception 'reviewed steps are required before publishing'; end if;
 if d.catalog_item_id is null then
   insert into public.catalog_items(restaurant_id,name,description,price_cents,image_key,image_url,category,active,published_steps,published_at)
   values(d.restaurant_id,d.name,d.description,d.price_cents,d.image_key,d.image_url,d.category,d.active,p_reviewed_steps,now()) returning * into i;
   update public.prep_drafts set catalog_item_id=i.id where id=d.id;
 else
   update public.catalog_items set name=d.name,description=d.description,price_cents=d.price_cents,image_key=d.image_key,image_url=d.image_url,
     category=d.category,active=d.active,published_steps=p_reviewed_steps,published_at=now(),updated_at=now()
   where id=d.catalog_item_id and restaurant_id=d.restaurant_id returning * into i;
   if not found then raise exception 'catalog item unavailable'; end if;
 end if;
 return i;
end $$;

create or replace function public.operator_analytics(p_from timestamptz,p_to timestamptz)
returns table(event_type text,event_count bigint,unique_users bigint,orders bigint,gross_cents bigint)
language plpgsql stable security definer set search_path=public,auth as $$
begin
 if not public.is_operator() then raise exception 'operator access required' using errcode='42501'; end if;
 return query select e.event_type,count(*),count(distinct e.user_id),count(*) filter(where e.event_type='order_placed'),
   coalesce(sum((e.payload->>'subtotal_cents')::bigint) filter(where e.event_type='order_placed'),0)
 from public.analytics_events e where e.created_at>=p_from and e.created_at<p_to group by e.event_type order by e.event_type;
end $$;

alter table public.profiles enable row level security;
alter table public.user_equipment enable row level security;
alter table public.consent_records enable row level security;
alter table public.restaurants enable row level security;
alter table public.merchant_memberships enable row level security;
alter table public.catalog_items enable row level security;
alter table public.prep_drafts enable row level security;
alter table public.pickup_slots enable row level security;
alter table public.slot_item_inventory enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.analytics_events enable row level security;
alter table public.waitlist_entries enable row level security;
alter table public.privacy_requests enable row level security;

create policy profile_self_select on public.profiles for select to authenticated using(id=auth.uid());
create policy profile_self_insert on public.profiles for insert to authenticated with check(id=auth.uid());
create policy profile_self_update on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
create policy equipment_self on public.user_equipment for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy consent_self_select on public.consent_records for select to authenticated using(user_id=auth.uid());
create policy consent_self_insert on public.consent_records for insert to authenticated with check(user_id=auth.uid());
create policy restaurants_public_read on public.restaurants for select to anon,authenticated using(active);
create policy restaurants_merchant_read on public.restaurants for select to authenticated using(public.is_restaurant_member(id));
create policy restaurants_merchant_curbside on public.restaurants for update to authenticated using(
  exists(select 1 from public.merchant_memberships m where m.restaurant_id=id and m.user_id=auth.uid() and m.role in ('owner','manager'))
) with check(
  exists(select 1 from public.merchant_memberships m where m.restaurant_id=id and m.user_id=auth.uid() and m.role in ('owner','manager'))
);
create policy memberships_self_select on public.merchant_memberships for select to authenticated using(user_id=auth.uid());
create policy catalog_public_published on public.catalog_items for select to anon,authenticated using(active and published_at is not null);
create policy catalog_merchant_manage on public.catalog_items for all to authenticated using(public.is_restaurant_member(restaurant_id)) with check(public.is_restaurant_member(restaurant_id));
create policy drafts_merchant_only on public.prep_drafts for all to authenticated using(public.is_restaurant_member(restaurant_id)) with check(public.is_restaurant_member(restaurant_id));
create policy slots_public_read on public.pickup_slots for select to anon,authenticated using(active and cutoff_at > now());
create policy slots_merchant_manage on public.pickup_slots for all to authenticated using(public.is_restaurant_member(restaurant_id)) with check(public.is_restaurant_member(restaurant_id));
create policy inventory_public_read on public.slot_item_inventory for select to anon,authenticated using(exists(select 1 from public.pickup_slots s where s.id=slot_id and s.active and s.cutoff_at>now()));
create policy inventory_merchant_manage on public.slot_item_inventory for all to authenticated using(exists(select 1 from public.pickup_slots s where s.id=slot_id and public.is_restaurant_member(s.restaurant_id))) with check(exists(select 1 from public.pickup_slots s where s.id=slot_id and public.is_restaurant_member(s.restaurant_id)));
create policy orders_customer_read on public.orders for select to authenticated using(user_id=auth.uid() or public.is_restaurant_member(restaurant_id));
create policy order_items_customer_read on public.order_items for select to authenticated using(exists(select 1 from public.orders o where o.id=order_id and (o.user_id=auth.uid() or public.is_restaurant_member(o.restaurant_id))));
create policy analytics_customer_insert on public.analytics_events for insert to authenticated with check(user_id=auth.uid());
create policy analytics_operator_read on public.analytics_events for select to authenticated using(public.is_operator());
create policy privacy_insert_public on public.privacy_requests for insert to anon,authenticated with check(length(trim(email)) between 5 and 320 and length(details)<=2000 and (user_id is null or user_id=auth.uid()));
create policy privacy_self_read on public.privacy_requests for select to authenticated using(user_id=auth.uid());

revoke all on all tables in schema public from anon,authenticated;
grant select on public.restaurants,public.catalog_items,public.pickup_slots,public.slot_item_inventory to anon,authenticated;
grant update(curbside_enabled) on public.restaurants to authenticated;
grant select,insert,update on public.profiles to authenticated;
grant select,insert,update,delete on public.user_equipment to authenticated;
grant select on public.consent_records to authenticated;
grant insert(user_id,consent_type,policy_version,consent_action) on public.consent_records to authenticated;
grant select on public.merchant_memberships to authenticated;
grant select,delete on public.catalog_items to authenticated;
grant insert(restaurant_id,name,description,price_cents,regular_price_cents,equipment,allergens,image_key,image_url,category,active,prep_minutes) on public.catalog_items to authenticated;
grant update(name,description,price_cents,regular_price_cents,equipment,allergens,image_key,image_url,category,active,prep_minutes,updated_at) on public.catalog_items to authenticated;
grant select,insert,update,delete on public.prep_drafts to authenticated;
grant select,delete on public.pickup_slots to authenticated;
grant insert(restaurant_id,starts_at,ends_at,cutoff_at,capacity,active) on public.pickup_slots to authenticated;
grant update(starts_at,ends_at,cutoff_at,capacity,active) on public.pickup_slots to authenticated;
grant select,delete on public.slot_item_inventory to authenticated;
grant insert(slot_id,item_id,available_qty) on public.slot_item_inventory to authenticated;
grant update(available_qty) on public.slot_item_inventory to authenticated;
grant select on public.orders,public.order_items to authenticated;
grant select on public.analytics_events to authenticated;
grant insert(user_id,email,request_type,details) on public.privacy_requests to anon,authenticated;
grant select on public.privacy_requests to authenticated;
revoke all on function public.create_order(uuid,uuid,text,text,jsonb,jsonb) from public,anon;
revoke all on function public.update_order_status(uuid,text) from public,anon;
revoke all on function public.track_event(text,uuid,jsonb) from public,anon;
revoke all on function public.join_waitlist(text,text) from public;
revoke all on function public.publish_prep_draft(uuid,timestamptz,text[]) from public,anon;
revoke all on function public.operator_analytics(timestamptz,timestamptz) from public,anon;
grant execute on function public.create_order(uuid,uuid,text,text,jsonb,jsonb) to authenticated;
grant execute on function public.update_order_status(uuid,text) to authenticated;
grant execute on function public.track_event(text,uuid,jsonb) to authenticated;
grant execute on function public.join_waitlist(text,text) to anon,authenticated;
grant execute on function public.publish_prep_draft(uuid,timestamptz,text[]) to authenticated;
grant execute on function public.operator_analytics(timestamptz,timestamptz) to authenticated;
revoke all on function public.is_restaurant_member(uuid) from public;
grant execute on function public.is_restaurant_member(uuid) to authenticated;
