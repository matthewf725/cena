-- Keep quotes from accepting slots that checkout will reject at reservation time,
-- and release inventory locks in the same slot-then-item order as create_order.
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
    and starts_at>clock_timestamp()+interval '32 minutes' and cutoff_at>clock_timestamp();
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

create or replace function public.release_checkout_reservation(p_order_id uuid,p_result text)
returns boolean language plpgsql security definer set search_path=public,auth as $$
declare o public.orders%rowtype; v_item uuid;
begin
  select * into o from public.orders where id=p_order_id for update;
  if not found or o.payment_method<>'stripe_checkout' or o.status<>'pending_payment' or o.payment_status<>'pending' then return false; end if;
  if p_result not in ('expired','failed','cancelled') then raise exception 'invalid checkout result'; end if;

  -- Match create_order: acquire pickup_slots before slot_item_inventory, and
  -- lock inventory rows by item UUID before modifying either resource.
  perform 1 from public.pickup_slots where id=o.slot_id for update;
  for v_item in
    select i.item_id from public.slot_item_inventory i
    join public.order_items x on x.item_id=i.item_id and x.order_id=o.id
    where i.slot_id=o.slot_id order by i.item_id
  loop
    perform 1 from public.slot_item_inventory where slot_id=o.slot_id and item_id=v_item for update;
  end loop;
  update public.pickup_slots set reserved_count=greatest(0,reserved_count-1) where id=o.slot_id;
  update public.slot_item_inventory i set reserved_qty=greatest(0,i.reserved_qty-x.quantity)
    from public.order_items x where x.order_id=o.id and i.slot_id=o.slot_id and i.item_id=x.item_id;
  if o.promotion_id is not null then
    update public.restaurant_promotions set reserved_redemptions=greatest(0,reserved_redemptions-1),updated_at=now() where id=o.promotion_id;
  end if;
  update public.orders set status='cancelled',payment_status=p_result,updated_at=now() where id=o.id;
  update public.order_checkout_sessions set status=p_result,updated_at=now() where order_id=o.id;
  return true;
end $$;

revoke all on function public.quote_checkout_order(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.release_checkout_reservation(uuid,text) from public,anon,authenticated;
grant execute on function public.quote_checkout_order(uuid,uuid,uuid,jsonb,text) to service_role;
grant execute on function public.release_checkout_reservation(uuid,text) to service_role;
notify pgrst, 'reload schema';
