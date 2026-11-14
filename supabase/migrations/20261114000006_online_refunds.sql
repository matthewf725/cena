alter table public.orders drop constraint orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('pay_at_pickup','pending','paid','expired','failed','cancelled','refunded'));

create table public.checkout_refunds (
  order_id uuid primary key references public.orders(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','succeeded','failed')),
  stripe_refund_id text unique,
  attempt integer not null default 1 check (attempt > 0),
  updated_at timestamptz not null default now()
);
alter table public.checkout_refunds enable row level security;
revoke all on public.checkout_refunds from public, anon, authenticated;

drop policy orders_customer_read on public.orders;
create policy orders_customer_read on public.orders for select to authenticated
  using(user_id=auth.uid() or (public.is_restaurant_member(restaurant_id)
    and payment_status in ('pay_at_pickup','paid','refunded')));
drop policy order_items_customer_read on public.order_items;
create policy order_items_customer_read on public.order_items for select to authenticated
  using(exists(select 1 from public.orders o where o.id=order_id and
    (o.user_id=auth.uid() or (public.is_restaurant_member(o.restaurant_id)
      and o.payment_status in ('pay_at_pickup','paid','refunded')))));

create or replace function public.prevent_online_order_cancel_without_refund() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if old.payment_method='stripe_checkout' and old.payment_status='paid' and new.status is distinct from old.status then
    if new.status='cancelled' and new.payment_status='refunded' and exists (
      select 1 from public.checkout_refunds where order_id=old.id and status='succeeded'
    ) then return new; end if;
    if new.status='cancelled' or exists (select 1 from public.checkout_refunds where order_id=old.id and status='pending') then
      raise exception 'refund must finish before changing this order';
    end if;
  end if;
  return new;
end $$;

create function public.begin_checkout_refund(p_user_id uuid,p_order_id uuid) returns jsonb
language plpgsql security definer set search_path=public,auth as $$
declare o public.orders%rowtype; s public.order_checkout_sessions%rowtype; f public.checkout_refunds%rowtype;
begin
  select * into o from public.orders where id=p_order_id for update;
  if not found or not exists (select 1 from public.merchant_memberships m where m.user_id=p_user_id
    and m.restaurant_id=o.restaurant_id and m.role in ('owner','manager')) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  if o.payment_status='refunded' then return jsonb_build_object('status','refunded'); end if;
  if o.payment_method<>'stripe_checkout' or o.payment_status<>'paid' or o.status not in ('placed','accepted','preparing','ready') then
    raise exception 'this order cannot be refunded through Cena';
  end if;
  select * into s from public.order_checkout_sessions where order_id=o.id and status='paid';
  if not found or s.stripe_session_id is null then raise exception 'payment session is unavailable'; end if;
  insert into public.checkout_refunds(order_id) values(o.id)
    on conflict (order_id) do update set status='pending',stripe_refund_id=null,
      attempt=checkout_refunds.attempt+1,updated_at=now() where checkout_refunds.status='failed';
  select * into f from public.checkout_refunds where order_id=o.id;
  return jsonb_build_object('status',f.status,'order_id',o.id,'attempt',f.attempt,'refund_id',f.stripe_refund_id,
    'session_id',s.stripe_session_id,'stripe_account_id',s.stripe_account_id,'amount_cents',s.amount_cents,
    'currency',s.currency,'application_fee_cents',s.application_fee_cents,'expires_at',s.expires_at);
end $$;

create function public.record_checkout_refund(p_order_id uuid,p_attempt integer,p_refund_id text,p_status text) returns text
language plpgsql security definer set search_path=public,auth as $$
declare o public.orders%rowtype; f public.checkout_refunds%rowtype;
begin
  if p_status is null or p_status not in ('pending','succeeded','failed')
     or (p_refund_id is not null and p_refund_id !~ '^re_[A-Za-z0-9]+$')
     or (p_status in ('succeeded','pending') and p_refund_id is null) then raise exception 'invalid refund result'; end if;
  select * into o from public.orders where id=p_order_id for update;
  select * into f from public.checkout_refunds where order_id=p_order_id for update;
  if not found or p_attempt is distinct from f.attempt then raise exception 'refund attempt mismatch'; end if;
  if f.status='succeeded' and o.payment_status='refunded' then return 'refunded'; end if;
  if f.status<>'pending' or (f.stripe_refund_id is not null and p_refund_id is distinct from f.stripe_refund_id) then
    raise exception 'refund does not match this order';
  end if;
  update public.checkout_refunds set status=p_status,stripe_refund_id=p_refund_id,updated_at=now() where order_id=p_order_id;
  if p_status<>'succeeded' then return p_status; end if;
  update public.pickup_slots set reserved_count=greatest(0,reserved_count-1) where id=o.slot_id;
  update public.slot_item_inventory i set reserved_qty=greatest(0,i.reserved_qty-x.quantity)
    from public.order_items x where x.order_id=o.id and i.slot_id=o.slot_id and i.item_id=x.item_id;
  update public.orders set status='cancelled',payment_status='refunded',updated_at=now() where id=o.id;
  return 'refunded';
end $$;

create function public.checkout_refund_event_context(p_order_id uuid,p_attempt integer,p_account_id text) returns jsonb
language sql stable security definer set search_path=public as $$
  select jsonb_build_object('order_id',s.order_id,'amount_cents',s.amount_cents,'currency',s.currency,
    'application_fee_cents',s.application_fee_cents,'stripe_account_id',s.stripe_account_id,
    'session_id',s.stripe_session_id,'expires_at',s.expires_at,'refund_id',f.stripe_refund_id)
  from public.order_checkout_sessions s join public.checkout_refunds f on f.order_id=s.order_id
  where s.order_id=p_order_id and s.stripe_account_id=p_account_id and f.attempt=p_attempt and f.status='pending';
$$;

revoke all on function public.begin_checkout_refund(uuid,uuid), public.record_checkout_refund(uuid,integer,text,text)
  from public, anon, authenticated;
grant execute on function public.begin_checkout_refund(uuid,uuid), public.record_checkout_refund(uuid,integer,text,text) to service_role;
revoke all on function public.checkout_refund_event_context(uuid,integer,text) from public, anon, authenticated;
grant execute on function public.checkout_refund_event_context(uuid,integer,text) to service_role;
notify pgrst, 'reload schema';
