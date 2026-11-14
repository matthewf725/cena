-- Online Checkout orders are reserved but hidden from merchants until Stripe confirms payment.
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check
  check(payment_method in ('pay_at_pickup','stripe_checkout'));
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check(status in ('pending_payment','placed','accepted','preparing','ready','completed','cancelled'));
alter table public.orders add column if not exists payment_status text not null default 'pay_at_pickup'
  check(payment_status in ('pay_at_pickup','pending','paid','expired','failed','cancelled'));
alter table public.orders add column if not exists application_fee_cents integer
  check(application_fee_cents is null or application_fee_cents >= 0);

create table if not exists public.order_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id),
  stripe_account_id text not null,
  amount_cents integer not null check(amount_cents > 0),
  application_fee_cents integer not null check(application_fee_cents >= 0 and application_fee_cents <= amount_cents),
  currency text not null default 'usd' check(currency='usd'),
  stripe_session_id text unique,
  checkout_url text,
  expires_at timestamptz not null,
  status text not null default 'creating' check(status in ('creating','open','paid','expired','failed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index order_checkout_sessions_pending_expiry_idx on public.order_checkout_sessions(expires_at)
  where status in ('creating','open');
create unique index orders_one_pending_online_per_customer_idx on public.orders(user_id)
  where payment_method='stripe_checkout' and payment_status='pending';

create table if not exists public.stripe_checkout_events (
  event_id text primary key,
  event_type text not null,
  stripe_session_id text,
  processed_at timestamptz not null default now(),
  outcome text not null default 'received'
);

alter table public.order_checkout_sessions enable row level security;
alter table public.stripe_checkout_events enable row level security;
revoke all on public.order_checkout_sessions,public.stripe_checkout_events from anon,authenticated;
grant select,insert,update,delete on public.order_checkout_sessions,public.stripe_checkout_events to service_role;

-- Existing direct create_order writes remain usable only inside this SECURITY DEFINER transaction;
-- public/mobile callers must use the Stripe Checkout route.
revoke all on function public.create_order(uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;

drop policy if exists orders_customer_read on public.orders;
create policy orders_customer_read on public.orders for select to authenticated
  using(user_id=auth.uid() or (public.is_restaurant_member(restaurant_id) and payment_status in ('pay_at_pickup','paid')));
drop policy if exists order_items_customer_read on public.order_items;
create policy order_items_customer_read on public.order_items for select to authenticated
  using(exists(select 1 from public.orders o where o.id=order_id and
    (o.user_id=auth.uid() or (public.is_restaurant_member(o.restaurant_id) and o.payment_status in ('pay_at_pickup','paid')))));

create or replace function public.release_checkout_reservation(p_order_id uuid,p_result text)
returns boolean language plpgsql security definer set search_path=public,auth as $$
declare o public.orders%rowtype;
begin
  select * into o from public.orders where id=p_order_id for update;
  if not found or o.payment_method<>'stripe_checkout' or o.status<>'pending_payment' or o.payment_status<>'pending' then
    return false;
  end if;
  if p_result not in ('expired','failed','cancelled') then raise exception 'invalid checkout result'; end if;
  update public.slot_item_inventory i set reserved_qty=greatest(0,i.reserved_qty-x.quantity)
    from public.order_items x where x.order_id=o.id and i.slot_id=o.slot_id and i.item_id=x.item_id;
  update public.pickup_slots set reserved_count=greatest(0,reserved_count-1) where id=o.slot_id;
  update public.orders set status='cancelled',payment_status=p_result,updated_at=now() where id=o.id;
  update public.order_checkout_sessions set status=p_result,updated_at=now() where order_id=o.id;
  return true;
end $$;

create or replace function public.reserve_checkout_order(
  p_user_id uuid,p_restaurant_id uuid,p_slot_id uuid,p_idempotency_key text,p_pickup_mode text,p_vehicle jsonb,p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare v_user uuid:=p_user_id; v_order public.orders%rowtype; v_existing public.orders%rowtype;
  v_account public.restaurant_payment_accounts%rowtype; v_session public.order_checkout_sessions%rowtype;
  v_expires timestamptz;
begin
  if v_user is null then raise exception 'authentication required' using errcode='42501'; end if;
  perform set_config('request.jwt.claim.sub',v_user::text,true);
  -- A Checkout Session that never became reachable can be released after its provider expiry.
  -- A recorded Checkout Session always requires verified Stripe expiry or cancellation.
  for v_session in
    select * from public.order_checkout_sessions where user_id=v_user and status='creating'
      and stripe_session_id is null and expires_at<=clock_timestamp()
  loop
    perform public.expire_checkout_if_due(v_session.order_id);
  end loop;
  select * into v_existing from public.orders where user_id=v_user and idempotency_key=p_idempotency_key;
  if found and v_existing.payment_method<>'stripe_checkout' then
    raise exception 'idempotency key is already attached to a pay-at-pickup order';
  end if;

  v_order:=public.create_order(p_restaurant_id,p_slot_id,p_idempotency_key,p_pickup_mode,p_vehicle,p_items);
  select * into v_order from public.orders where id=v_order.id for update;
  if v_order.payment_method='stripe_checkout' then
    select * into v_session from public.order_checkout_sessions where order_id=v_order.id;
    if not found then raise exception 'checkout reservation is not ready'; end if;
    return jsonb_build_object('order_id',v_order.id,'amount_cents',v_session.amount_cents,'currency',v_session.currency,
      'application_fee_cents',v_session.application_fee_cents,'stripe_account_id',v_session.stripe_account_id,
      'session_id',v_session.stripe_session_id,'checkout_url',v_session.checkout_url,'expires_at',v_session.expires_at,
      'status',v_order.payment_status);
  end if;

  select * into v_account from public.restaurant_payment_accounts a where a.restaurant_id=p_restaurant_id
    and a.charges_enabled and a.payouts_enabled;
  if not found or nullif(v_account.stripe_account_id,'') is null then raise exception 'restaurant payments are not enabled'; end if;
  if v_account.application_fee_cents < 150 or v_account.application_fee_cents > 200 then raise exception 'restaurant fee is not configured'; end if;
  if v_order.subtotal_cents < v_account.application_fee_cents then raise exception 'order amount is below the platform fee'; end if;
  if v_order.pickup_starts_at <= clock_timestamp()+interval '32 minutes' then raise exception 'online checkout closes 32 minutes before pickup'; end if;

  v_expires:=clock_timestamp()+interval '31 minutes';
  update public.orders set status='pending_payment',payment_method='stripe_checkout',payment_status='pending',
    application_fee_cents=v_account.application_fee_cents,updated_at=now() where id=v_order.id returning * into v_order;
  delete from public.analytics_events where event_type='order_placed' and payload->>'order_id'=v_order.id::text;
  insert into public.order_checkout_sessions(order_id,user_id,restaurant_id,stripe_account_id,amount_cents,
    application_fee_cents,expires_at,status)
  values(v_order.id,v_user,p_restaurant_id,v_account.stripe_account_id,v_order.subtotal_cents,
    v_account.application_fee_cents,v_expires,'creating') returning * into v_session;
  return jsonb_build_object('order_id',v_order.id,'amount_cents',v_order.subtotal_cents,'currency','usd',
    'application_fee_cents',v_account.application_fee_cents,'stripe_account_id',v_account.stripe_account_id,
    'session_id',null,'checkout_url',null,'expires_at',v_expires,'status','pending');
end $$;

create or replace function public.record_checkout_session(
  p_order_id uuid,p_session_id text,p_checkout_url text,p_stripe_account_id text,
  p_amount_cents integer,p_application_fee_cents integer,p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare o public.orders%rowtype; s public.order_checkout_sessions%rowtype;
begin
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'checkout order not found'; end if;
  select * into s from public.order_checkout_sessions where order_id=p_order_id for update;
  if not found or o.status<>'pending_payment' or o.payment_status<>'pending' then raise exception 'checkout is no longer pending'; end if;
  if p_session_id is null or length(p_session_id)>255 or p_stripe_account_id is distinct from s.stripe_account_id
    or p_amount_cents is distinct from s.amount_cents or p_application_fee_cents is distinct from s.application_fee_cents
    or p_expires_at is distinct from s.expires_at then
    raise exception 'checkout data does not match the reservation';
  end if;
  if p_checkout_url is null or p_checkout_url !~ '^https://checkout\.stripe\.com(/|\?|$)' then raise exception 'invalid checkout URL'; end if;
  if s.stripe_session_id is not null and s.stripe_session_id<>p_session_id then raise exception 'checkout session already recorded'; end if;
  update public.order_checkout_sessions set stripe_session_id=p_session_id,checkout_url=p_checkout_url,status='open',updated_at=now()
    where order_id=p_order_id returning * into s;
  return jsonb_build_object('order_id',o.id,'checkout_url',s.checkout_url,'expires_at',s.expires_at,'status',o.payment_status);
end $$;

create or replace function public.get_checkout_for_owner(p_order_id uuid,p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,auth as $$
declare o public.orders%rowtype; s public.order_checkout_sessions%rowtype;
begin
  select * into o from public.orders where id=p_order_id and user_id=p_user_id;
  if not found then raise exception 'order not found' using errcode='42501'; end if;
  select * into s from public.order_checkout_sessions where order_id=p_order_id;
  if not found then raise exception 'checkout not found'; end if;
  return jsonb_build_object('order_id',o.id,'status',o.payment_status,'order_status',o.status,
    'session_id',s.stripe_session_id,'stripe_account_id',s.stripe_account_id,'amount_cents',s.amount_cents,
    'application_fee_cents',s.application_fee_cents,'currency',s.currency,'expires_at',s.expires_at);
end $$;

create or replace function public.release_expired_checkout(p_order_id uuid,p_expected_session_id text,p_expected_account_id text,p_result text)
returns text language plpgsql security definer set search_path=public,auth as $$
declare s public.order_checkout_sessions%rowtype; released boolean;
begin
  perform 1 from public.orders where id=p_order_id for update;
  if not found then raise exception 'checkout not found'; end if;
  select * into s from public.order_checkout_sessions where order_id=p_order_id for update;
  if not found or s.stripe_session_id is distinct from p_expected_session_id or s.stripe_account_id is distinct from p_expected_account_id then raise exception 'checkout session mismatch'; end if;
  released:=public.release_checkout_reservation(p_order_id,p_result);
  if not released then
    if exists(select 1 from public.orders where id=p_order_id and payment_status='paid') then return 'paid'; end if;
    return (select payment_status from public.orders where id=p_order_id);
  end if;
  return p_result;
end $$;

create or replace function public.expire_checkout_if_due(p_order_id uuid) returns text
language plpgsql security definer set search_path=public,auth as $$
declare s public.order_checkout_sessions%rowtype; released boolean; o public.orders%rowtype;
begin
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'checkout not found'; end if;
  select * into s from public.order_checkout_sessions where order_id=p_order_id for update;
  if not found then raise exception 'checkout not found'; end if;
  if s.stripe_session_id is not null or s.expires_at>clock_timestamp() then return o.payment_status; end if;
  released:=public.release_checkout_reservation(p_order_id,'expired');
  if not released then return (select payment_status from public.orders where id=p_order_id); end if;
  return 'expired';
end $$;

create or replace function public.fail_checkout_creation(p_order_id uuid) returns text
language plpgsql security definer set search_path=public,auth as $$
declare s public.order_checkout_sessions%rowtype; released boolean; o public.orders%rowtype;
begin
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'checkout not found'; end if;
  select * into s from public.order_checkout_sessions where order_id=p_order_id for update;
  if not found or s.stripe_session_id is not null then raise exception 'cannot release an established checkout session'; end if;
  released:=public.release_checkout_reservation(p_order_id,'failed');
  if not released then return (select payment_status from public.orders where id=p_order_id); end if;
  return 'failed';
end $$;

create or replace function public.finalize_checkout_event(
  p_event_id text,p_event_type text,p_order_id uuid,p_session_id text,p_stripe_account_id text,
  p_amount_total_cents integer,p_application_fee_cents integer,p_currency text,p_payment_status text,
  p_event_created_at timestamptz
) returns text language plpgsql security definer set search_path=public,auth as $$
declare s public.order_checkout_sessions%rowtype; o public.orders%rowtype; inserted integer;
begin
  if p_event_type not in ('checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired') then
    raise exception 'unsupported checkout event';
  end if;
  if p_event_created_at is null or p_payment_status is null or p_payment_status not in ('paid','unpaid','no_payment_required') then
    raise exception 'invalid checkout event payment state';
  end if;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'order not found'; end if;
  select * into s from public.order_checkout_sessions where order_id=p_order_id for update;
  if not found or s.stripe_session_id is distinct from p_session_id or s.stripe_account_id is distinct from p_stripe_account_id
    or s.amount_cents is distinct from p_amount_total_cents or s.application_fee_cents is distinct from p_application_fee_cents
    or lower(s.currency) is distinct from lower(p_currency) or p_currency is distinct from 'usd'
    or p_event_id is null or length(p_event_id) not between 1 and 255 then raise exception 'checkout event does not match reservation'; end if;
  insert into public.stripe_checkout_events(event_id,event_type,stripe_session_id)
    values(p_event_id,p_event_type,p_session_id) on conflict(event_id) do nothing;
  get diagnostics inserted = row_count;
  if inserted=0 then return o.payment_status; end if;
  if p_event_type in ('checkout.session.completed','checkout.session.async_payment_succeeded') and p_payment_status='paid' then
    if p_event_created_at>=o.pickup_starts_at then raise exception 'checkout completed after pickup began'; end if;
    if o.payment_status='paid' then update public.stripe_checkout_events set outcome='paid_duplicate' where event_id=p_event_id; return 'paid'; end if;
    if o.status<>'pending_payment' or o.payment_status<>'pending' then raise exception 'order is no longer payable'; end if;
    update public.orders set payment_status='paid',status='placed',updated_at=now() where id=p_order_id;
    update public.order_checkout_sessions set status='paid',updated_at=now() where order_id=p_order_id;
    update public.stripe_checkout_events set outcome='paid' where event_id=p_event_id;
    insert into public.analytics_events(user_id,restaurant_id,event_type,payload)
      values(o.user_id,o.restaurant_id,'order_placed',jsonb_build_object('order_id',o.id,'source','stripe_checkout'));
    return 'paid';
  end if;
  if p_event_type='checkout.session.completed' and p_payment_status<>'paid' then
    update public.stripe_checkout_events set outcome='awaiting_async_payment' where event_id=p_event_id;
    return 'pending';
  end if;
  if p_event_type='checkout.session.expired' then
    perform public.release_checkout_reservation(p_order_id,'expired');
    update public.stripe_checkout_events set outcome='expired' where event_id=p_event_id;
    return 'expired';
  end if;
  if p_event_type='checkout.session.async_payment_failed' then
    perform public.release_checkout_reservation(p_order_id,'failed');
    update public.stripe_checkout_events set outcome='failed' where event_id=p_event_id;
    return 'failed';
  end if;
  return 'pending';
end $$;

create or replace function public.cancel_checkout_if_unpaid(p_order_id uuid,p_session_id text,p_stripe_account_id text) returns text
language plpgsql security definer set search_path=public,auth as $$
declare s public.order_checkout_sessions%rowtype; released boolean; o public.orders%rowtype;
begin
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'checkout not found'; end if;
  select * into s from public.order_checkout_sessions where order_id=p_order_id for update;
  if not found or s.stripe_session_id is distinct from p_session_id or s.stripe_account_id is distinct from p_stripe_account_id then raise exception 'checkout session mismatch'; end if;
  released:=public.release_checkout_reservation(p_order_id,'cancelled');
  if not released then
    if exists(select 1 from public.orders where id=p_order_id and payment_status='paid') then return 'paid'; end if;
    return (select payment_status from public.orders where id=p_order_id);
  end if;
  return 'cancelled';
end $$;

-- Merchant cancel remains allowed for pay-at-pickup history; paid online orders require a refund first.
create or replace function public.prevent_online_order_cancel_without_refund() returns trigger
language plpgsql set search_path=public as $$
begin
  if new.status='cancelled' and old.status<>'cancelled' and old.payment_method='stripe_checkout' and old.payment_status='paid' then
    raise exception 'refund required before cancelling a paid online order';
  end if;
  return new;
end $$;
drop trigger if exists block_paid_online_order_cancel on public.orders;
create trigger block_paid_online_order_cancel before update of status on public.orders
  for each row execute function public.prevent_online_order_cancel_without_refund();

revoke all on function public.release_checkout_reservation(uuid,text) from public,anon,authenticated;
revoke all on function public.reserve_checkout_order(uuid,uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.record_checkout_session(uuid,text,text,text,integer,integer,timestamptz) from public,anon,authenticated;
revoke all on function public.get_checkout_for_owner(uuid,uuid) from public,anon,authenticated;
revoke all on function public.release_expired_checkout(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.expire_checkout_if_due(uuid) from public,anon,authenticated;
revoke all on function public.fail_checkout_creation(uuid) from public,anon,authenticated;
revoke all on function public.finalize_checkout_event(text,text,uuid,text,text,integer,integer,text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.cancel_checkout_if_unpaid(uuid,text,text) from public,anon,authenticated;
grant execute on function public.reserve_checkout_order(uuid,uuid,uuid,text,text,jsonb,jsonb) to service_role;
grant execute on function public.record_checkout_session(uuid,text,text,text,integer,integer,timestamptz) to service_role;
grant execute on function public.get_checkout_for_owner(uuid,uuid) to service_role;
grant execute on function public.release_expired_checkout(uuid,text,text,text) to service_role;
grant execute on function public.expire_checkout_if_due(uuid) to service_role;
grant execute on function public.fail_checkout_creation(uuid) to service_role;
grant execute on function public.finalize_checkout_event(text,text,uuid,text,text,integer,integer,text,text,timestamptz) to service_role;
grant execute on function public.cancel_checkout_if_unpaid(uuid,text,text) to service_role;

notify pgrst, 'reload schema';
