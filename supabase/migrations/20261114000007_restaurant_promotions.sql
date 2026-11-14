-- Restaurant-funded percentage promotions. No promotion is seeded or activated here.
create table public.restaurant_promotions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  code text not null check (code=upper(code) and code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  discount_percent integer not null check (discount_percent between 1 and 90),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
  reserved_redemptions integer not null default 0 check (reserved_redemptions >= 0),
  redeemed_count integer not null default 0 check (redeemed_count >= 0),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at),
  check (max_redemptions is null or max_redemptions >= reserved_redemptions + redeemed_count),
  unique (restaurant_id,code)
);
create index restaurant_promotions_available_idx on public.restaurant_promotions(restaurant_id,code)
  where active;
alter table public.restaurant_promotions enable row level security;
revoke all on public.restaurant_promotions from public,anon,authenticated;
grant select,insert,update,delete on public.restaurant_promotions to service_role;

alter table public.orders
  add column promotion_id uuid references public.restaurant_promotions(id) on delete restrict,
  add column promo_code_snapshot text,
  add column discount_percent integer check (discount_percent is null or discount_percent between 1 and 90),
  add column discount_cents integer not null default 0 check (discount_cents >= 0 and discount_cents <= subtotal_cents),
  add column total_cents integer generated always as (subtotal_cents-discount_cents) stored;

alter table public.order_checkout_sessions
  add column subtotal_cents integer not null default 0,
  add column discount_cents integer not null default 0,
  add column promotion_id uuid references public.restaurant_promotions(id) on delete restrict,
  add column promo_code_snapshot text,
  add column discount_percent integer;
update public.order_checkout_sessions set subtotal_cents=amount_cents where subtotal_cents=0;
alter table public.order_checkout_sessions
  add constraint order_checkout_sessions_discount_check check (discount_cents >= 0 and discount_cents <= subtotal_cents),
  add constraint order_checkout_sessions_total_check check (amount_cents = subtotal_cents-discount_cents),
  add constraint order_checkout_sessions_discount_percent_check check (discount_percent is null or discount_percent between 1 and 90);

create or replace function public.promotion_json(p public.restaurant_promotions) returns jsonb
language sql immutable set search_path=public as $$
  select jsonb_build_object(
    'id',p.id,'restaurant_id',p.restaurant_id,'code',p.code,'discount_percent',p.discount_percent,
    'starts_at',p.starts_at,'ends_at',p.ends_at,'max_redemptions',p.max_redemptions,
    'reserved_redemptions',p.reserved_redemptions,'redeemed_count',p.redeemed_count,
    'redemption_count',p.redeemed_count,'active',p.active,'created_at',p.created_at,'updated_at',p.updated_at
  );
$$;
revoke all on function public.promotion_json(public.restaurant_promotions) from public,anon,authenticated;

create or replace function public.save_restaurant_promotion(
  p_restaurant_id uuid,p_code text,p_discount_percent integer,p_starts_at timestamptz,
  p_ends_at timestamptz,p_max_redemptions integer,p_active boolean
) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare v_code text:=upper(trim(coalesce(p_code,''))); v_promo public.restaurant_promotions%rowtype;
begin
  if auth.uid() is null or not exists (
    select 1 from public.merchant_memberships m where m.restaurant_id=p_restaurant_id
      and m.user_id=auth.uid() and m.role in ('owner','manager')
  ) then raise exception 'not authorized' using errcode='42501'; end if;
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{2,31}$' then raise exception 'promo code must be 3–32 letters, numbers, hyphens, or underscores'; end if;
  if p_discount_percent not between 1 and 90 then raise exception 'discount must be 1–90 percent'; end if;
  if p_starts_at is null or p_active is null or (p_ends_at is not null and p_ends_at<=p_starts_at)
    or (p_max_redemptions is not null and p_max_redemptions<=0) then raise exception 'invalid promo schedule or redemption limit'; end if;
  insert into public.restaurant_promotions(restaurant_id,code,discount_percent,starts_at,ends_at,max_redemptions,active)
    values(p_restaurant_id,v_code,p_discount_percent,p_starts_at,p_ends_at,p_max_redemptions,p_active)
  on conflict (restaurant_id,code) do update set discount_percent=excluded.discount_percent,
    starts_at=excluded.starts_at,ends_at=excluded.ends_at,max_redemptions=excluded.max_redemptions,
    active=excluded.active,updated_at=now()
  returning * into v_promo;
  return public.promotion_json(v_promo);
end $$;

create or replace function public.list_restaurant_promotions(p_restaurant_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,auth as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.merchant_memberships m where m.restaurant_id=p_restaurant_id
      and m.user_id=auth.uid() and m.role in ('owner','manager')
  ) then raise exception 'not authorized' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(public.promotion_json(p) order by p.created_at desc,p.code)
    from public.restaurant_promotions p where p.restaurant_id=p_restaurant_id),'[]'::jsonb);
end $$;

create or replace function public.quote_checkout_order(
  p_user_id uuid,p_restaurant_id uuid,p_slot_id uuid,p_items jsonb,p_promo_code text
) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare v_code text:=nullif(upper(trim(coalesce(p_promo_code,''))), ''); v_pct integer; v_subtotal bigint:=0;
  v_discount bigint:=0; v_total bigint; v_slot public.pickup_slots%rowtype; v_account public.restaurant_payment_accounts%rowtype;
  v_row record; v_promo public.restaurant_promotions%rowtype;
begin
  if p_user_id is null or not exists(select 1 from auth.users where id=p_user_id) then raise exception 'authentication required' using errcode='42501'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'invalid checkout items'; end if;
  if jsonb_array_length(p_items) not between 1 and 30
    or exists(select 1 from jsonb_array_elements(p_items) x where coalesce(x->>'quantity','') !~ '^[1-9][0-9]?$' or x->>'item_id' is null) then
    raise exception 'invalid checkout items';
  end if;
  if v_code is not null and v_code !~ '^[A-Z0-9][A-Z0-9_-]{2,31}$' then raise exception 'invalid promo code'; end if;
  if not exists(select 1 from public.restaurants r where r.id=p_restaurant_id and r.active) then raise exception 'restaurant unavailable'; end if;
  select * into v_slot from public.pickup_slots where id=p_slot_id and restaurant_id=p_restaurant_id and active
    and starts_at>clock_timestamp() and cutoff_at>clock_timestamp();
  if not found then raise exception 'pickup slot closed'; end if;
  if v_slot.reserved_count>=v_slot.capacity then raise exception 'pickup slot full'; end if;
  for v_row in select (x->>'item_id')::uuid item_id,sum((x->>'quantity')::int)::int quantity
    from jsonb_array_elements(p_items) x group by 1 order by 1 loop
    if v_row.quantity not between 1 and 50 then raise exception 'invalid item quantity'; end if;
    if not exists(select 1 from public.catalog_items c join public.slot_item_inventory i on i.item_id=c.id and i.slot_id=p_slot_id
      where c.id=v_row.item_id and c.restaurant_id=p_restaurant_id and c.active and c.published_at is not null
        and i.available_qty-i.reserved_qty>=v_row.quantity) then raise exception 'menu item unavailable for selected slot'; end if;
    select v_subtotal+price_cents::bigint*v_row.quantity into v_subtotal from public.catalog_items where id=v_row.item_id;
    if v_subtotal>2147483647 then raise exception 'order total exceeds supported amount'; end if;
  end loop;
  if v_code is not null then
    select * into v_promo from public.restaurant_promotions p where p.restaurant_id=p_restaurant_id and p.code=v_code
      and p.active and p.starts_at<=clock_timestamp() and (p.ends_at is null or p.ends_at>clock_timestamp())
      and (p.max_redemptions is null or p.reserved_redemptions+p.redeemed_count<p.max_redemptions);
    if not found then raise exception 'promo code is unavailable'; end if;
    v_pct:=v_promo.discount_percent;
    v_discount:=(v_subtotal*v_pct+50)/100;
  end if;
  v_total:=v_subtotal-v_discount;
  select * into v_account from public.restaurant_payment_accounts a where a.restaurant_id=p_restaurant_id and a.charges_enabled and a.payouts_enabled;
  if not found then raise exception 'restaurant payments are not enabled'; end if;
  if v_total<v_account.application_fee_cents then raise exception 'order total is below the platform fee'; end if;
  return jsonb_build_object('restaurant_id',p_restaurant_id,'slot_id',p_slot_id,'subtotal_cents',v_subtotal,
    'discount_cents',v_discount,'amount_cents',v_total,'currency','usd','promo_code',v_code,'discount_percent',v_pct);
end $$;

create or replace function public.reserve_checkout_order(
  p_user_id uuid,p_restaurant_id uuid,p_slot_id uuid,p_idempotency_key text,p_pickup_mode text,p_vehicle jsonb,
  p_items jsonb,p_promo_code text,p_expected_amount_cents integer
) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare v_code text:=nullif(upper(trim(coalesce(p_promo_code,''))), ''); v_order public.orders%rowtype;
  v_existing public.orders%rowtype; v_account public.restaurant_payment_accounts%rowtype;
  v_session public.order_checkout_sessions%rowtype; v_promo public.restaurant_promotions%rowtype;
  v_discount integer:=0; v_expires timestamptz;
begin
  if p_user_id is null or not exists(select 1 from auth.users where id=p_user_id) then raise exception 'authentication required' using errcode='42501'; end if;
  if p_expected_amount_cents is null then raise exception 'a current checkout quote is required'; end if;
  if v_code is not null and v_code !~ '^[A-Z0-9][A-Z0-9_-]{2,31}$' then raise exception 'invalid promo code'; end if;
  perform set_config('request.jwt.claim.sub',p_user_id::text,true);
  for v_session in select * from public.order_checkout_sessions where user_id=p_user_id and status='creating'
    and stripe_session_id is null and expires_at<=clock_timestamp() loop
    perform public.expire_checkout_if_due(v_session.order_id);
  end loop;
  select * into v_existing from public.orders where user_id=p_user_id and idempotency_key=p_idempotency_key;
  if found and v_existing.payment_method<>'stripe_checkout' then raise exception 'idempotency key is already attached to another order'; end if;
  v_order:=public.create_order(p_restaurant_id,p_slot_id,p_idempotency_key,p_pickup_mode,p_vehicle,p_items);
  select * into v_order from public.orders where id=v_order.id for update;
  if v_order.payment_method='stripe_checkout' then
    select * into v_session from public.order_checkout_sessions where order_id=v_order.id;
    if not found then raise exception 'checkout reservation is not ready'; end if;
    if v_order.promo_code_snapshot is distinct from v_code or v_session.amount_cents is distinct from p_expected_amount_cents then
      raise exception 'quote changed; request a new quote';
    end if;
    return jsonb_build_object('order_id',v_order.id,'subtotal_cents',v_session.subtotal_cents,
      'discount_cents',v_session.discount_cents,'promo_code',v_session.promo_code_snapshot,
      'discount_percent',v_session.discount_percent,'amount_cents',v_session.amount_cents,'currency',v_session.currency,
      'application_fee_cents',v_session.application_fee_cents,'stripe_account_id',v_session.stripe_account_id,
      'session_id',v_session.stripe_session_id,'checkout_url',v_session.checkout_url,'expires_at',v_session.expires_at,
      'status',v_order.payment_status);
  end if;
  select * into v_account from public.restaurant_payment_accounts a where a.restaurant_id=p_restaurant_id and a.charges_enabled and a.payouts_enabled;
  if not found or nullif(v_account.stripe_account_id,'') is null then raise exception 'restaurant payments are not enabled'; end if;
  if v_order.pickup_starts_at<=clock_timestamp()+interval '32 minutes' then raise exception 'online checkout closes 32 minutes before pickup'; end if;
  if v_code is not null then
    select * into v_promo from public.restaurant_promotions p where p.restaurant_id=p_restaurant_id and p.code=v_code
      for update;
    if not found or not v_promo.active or v_promo.starts_at>clock_timestamp()
      or (v_promo.ends_at is not null and v_promo.ends_at<=clock_timestamp())
      or (v_promo.max_redemptions is not null and v_promo.reserved_redemptions+v_promo.redeemed_count>=v_promo.max_redemptions) then
      raise exception 'promo code is unavailable';
    end if;
    v_discount:=((v_order.subtotal_cents::bigint*v_promo.discount_percent+50)/100)::integer;
  end if;
  if v_order.subtotal_cents-v_discount<v_account.application_fee_cents then raise exception 'order total is below the platform fee'; end if;
  if p_expected_amount_cents is distinct from (v_order.subtotal_cents-v_discount) then raise exception 'quote changed; request a new quote'; end if;
  if v_code is not null then update public.restaurant_promotions set reserved_redemptions=reserved_redemptions+1,updated_at=now() where id=v_promo.id; end if;
  v_expires:=clock_timestamp()+interval '31 minutes';
  update public.orders set status='pending_payment',payment_method='stripe_checkout',payment_status='pending',
    promotion_id=v_promo.id,promo_code_snapshot=v_code,discount_percent=v_promo.discount_percent,discount_cents=v_discount,
    application_fee_cents=v_account.application_fee_cents,updated_at=now() where id=v_order.id returning * into v_order;
  delete from public.analytics_events where event_type='order_placed' and payload->>'order_id'=v_order.id::text;
  insert into public.order_checkout_sessions(order_id,user_id,restaurant_id,stripe_account_id,amount_cents,
    application_fee_cents,expires_at,status,subtotal_cents,discount_cents,promotion_id,promo_code_snapshot,discount_percent)
  values(v_order.id,p_user_id,p_restaurant_id,v_account.stripe_account_id,v_order.total_cents,v_account.application_fee_cents,
    v_expires,'creating',v_order.subtotal_cents,v_discount,v_promo.id,v_code,v_promo.discount_percent) returning * into v_session;
  return jsonb_build_object('order_id',v_order.id,'subtotal_cents',v_session.subtotal_cents,
    'discount_cents',v_session.discount_cents,'promo_code',v_session.promo_code_snapshot,
    'discount_percent',v_session.discount_percent,'amount_cents',v_session.amount_cents,'currency','usd',
    'application_fee_cents',v_session.application_fee_cents,'stripe_account_id',v_session.stripe_account_id,
    'session_id',null,'checkout_url',null,'expires_at',v_expires,'status','pending');
end $$;

create or replace function public.release_checkout_reservation(p_order_id uuid,p_result text)
returns boolean language plpgsql security definer set search_path=public,auth as $$
declare o public.orders%rowtype;
begin
  select * into o from public.orders where id=p_order_id for update;
  if not found or o.payment_method<>'stripe_checkout' or o.status<>'pending_payment' or o.payment_status<>'pending' then return false; end if;
  if p_result not in ('expired','failed','cancelled') then raise exception 'invalid checkout result'; end if;
  update public.slot_item_inventory i set reserved_qty=greatest(0,i.reserved_qty-x.quantity)
    from public.order_items x where x.order_id=o.id and i.slot_id=o.slot_id and i.item_id=x.item_id;
  update public.pickup_slots set reserved_count=greatest(0,reserved_count-1) where id=o.slot_id;
  if o.promotion_id is not null then
    update public.restaurant_promotions set reserved_redemptions=greatest(0,reserved_redemptions-1),updated_at=now() where id=o.promotion_id;
  end if;
  update public.orders set status='cancelled',payment_status=p_result,updated_at=now() where id=o.id;
  update public.order_checkout_sessions set status=p_result,updated_at=now() where order_id=o.id;
  return true;
end $$;

create or replace function public.finalize_checkout_event(
  p_event_id text,p_event_type text,p_order_id uuid,p_session_id text,p_stripe_account_id text,
  p_amount_total_cents integer,p_application_fee_cents integer,p_currency text,p_payment_status text,
  p_event_created_at timestamptz
) returns text language plpgsql security definer set search_path=public,auth as $$
declare s public.order_checkout_sessions%rowtype; o public.orders%rowtype; inserted integer;
begin
  if p_event_type not in ('checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired') then raise exception 'unsupported checkout event'; end if;
  if p_event_created_at is null or p_payment_status is null or p_payment_status not in ('paid','unpaid','no_payment_required') then raise exception 'invalid checkout event payment state'; end if;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'order not found'; end if;
  select * into s from public.order_checkout_sessions where order_id=p_order_id for update;
  if not found or s.stripe_session_id is distinct from p_session_id or s.stripe_account_id is distinct from p_stripe_account_id
    or s.amount_cents is distinct from p_amount_total_cents or s.application_fee_cents is distinct from p_application_fee_cents
    or lower(s.currency) is distinct from lower(p_currency) or p_currency is distinct from 'usd'
    or p_event_id is null or length(p_event_id) not between 1 and 255 then raise exception 'checkout event does not match reservation'; end if;
  insert into public.stripe_checkout_events(event_id,event_type,stripe_session_id) values(p_event_id,p_event_type,p_session_id) on conflict(event_id) do nothing;
  get diagnostics inserted=row_count;
  if inserted=0 then return o.payment_status; end if;
  if p_event_type in ('checkout.session.completed','checkout.session.async_payment_succeeded') and p_payment_status='paid' then
    if p_event_created_at>=o.pickup_starts_at then raise exception 'checkout completed after pickup began'; end if;
    if o.payment_status='paid' then update public.stripe_checkout_events set outcome='paid_duplicate' where event_id=p_event_id; return 'paid'; end if;
    if o.status<>'pending_payment' or o.payment_status<>'pending' then raise exception 'order is no longer payable'; end if;
    if o.promotion_id is not null then
      update public.restaurant_promotions set reserved_redemptions=greatest(0,reserved_redemptions-1),redeemed_count=redeemed_count+1,updated_at=now() where id=o.promotion_id;
    end if;
    update public.orders set payment_status='paid',status='placed',updated_at=now() where id=p_order_id;
    update public.order_checkout_sessions set status='paid',updated_at=now() where order_id=p_order_id;
    update public.stripe_checkout_events set outcome='paid' where event_id=p_event_id;
    insert into public.analytics_events(user_id,restaurant_id,event_type,payload) values(o.user_id,o.restaurant_id,'order_placed',jsonb_build_object('order_id',o.id,'source','stripe_checkout'));
    return 'paid';
  end if;
  if p_event_type='checkout.session.completed' and p_payment_status<>'paid' then update public.stripe_checkout_events set outcome='awaiting_async_payment' where event_id=p_event_id; return 'pending'; end if;
  if p_event_type='checkout.session.expired' then perform public.release_checkout_reservation(p_order_id,'expired'); update public.stripe_checkout_events set outcome='expired' where event_id=p_event_id; return 'expired'; end if;
  if p_event_type='checkout.session.async_payment_failed' then perform public.release_checkout_reservation(p_order_id,'failed'); update public.stripe_checkout_events set outcome='failed' where event_id=p_event_id; return 'failed'; end if;
  return 'pending';
end $$;

revoke all on function public.save_restaurant_promotion(uuid,text,integer,timestamptz,timestamptz,integer,boolean) from public,anon;
revoke all on function public.list_restaurant_promotions(uuid) from public,anon;
revoke all on function public.quote_checkout_order(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
drop function public.reserve_checkout_order(uuid,uuid,uuid,text,text,jsonb,jsonb);
revoke all on function public.reserve_checkout_order(uuid,uuid,uuid,text,text,jsonb,jsonb,text,integer) from public,anon,authenticated;
revoke all on function public.release_checkout_reservation(uuid,text) from public,anon,authenticated;
revoke all on function public.finalize_checkout_event(text,text,uuid,text,text,integer,integer,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.save_restaurant_promotion(uuid,text,integer,timestamptz,timestamptz,integer,boolean) to authenticated;
grant execute on function public.list_restaurant_promotions(uuid) to authenticated;
grant execute on function public.quote_checkout_order(uuid,uuid,uuid,jsonb,text) to service_role;
grant execute on function public.reserve_checkout_order(uuid,uuid,uuid,text,text,jsonb,jsonb,text,integer) to service_role;
grant execute on function public.release_checkout_reservation(uuid,text) to service_role;
grant execute on function public.finalize_checkout_event(text,text,uuid,text,text,integer,integer,text,text,timestamptz) to service_role;

notify pgrst, 'reload schema';
