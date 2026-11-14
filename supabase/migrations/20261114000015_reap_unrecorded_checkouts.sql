-- Expire abandoned reservation rows whose Checkout Session ID was never persisted.
-- No Checkout URL is returned until record_checkout_session commits; once the stored
-- provider expiry passes, releasing these unrecorded reservations cannot orphan a
-- reachable customer payment.
create or replace function public.reap_expired_unrecorded_checkout_reservations(p_limit integer default 25)
returns integer
language plpgsql security definer set search_path=public,auth as $$
declare v_order_id uuid; v_reaped integer:=0;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid checkout reaper batch size';
  end if;

  -- Lock orders first, matching record_checkout_session and expire_checkout_if_due.
  -- SKIP LOCKED lets multiple API instances run the periodic reaper safely.
  for v_order_id in
    select o.id
    from public.orders o
    join public.order_checkout_sessions s on s.order_id=o.id
    where o.payment_method='stripe_checkout' and o.payment_status='pending' and o.status='pending_payment'
      and s.status='creating' and s.stripe_session_id is null and s.expires_at<=clock_timestamp()
    -- Keep all reapers acquiring pickup-slot locks in a deterministic order.
    order by o.slot_id,s.expires_at,o.id
    for update of o skip locked
    limit p_limit
  loop
    if public.expire_checkout_if_due(v_order_id) in ('expired','failed','cancelled') then
      v_reaped:=v_reaped+1;
    end if;
  end loop;
  return v_reaped;
end $$;

revoke all on function public.reap_expired_unrecorded_checkout_reservations(integer) from public,anon,authenticated;
grant execute on function public.reap_expired_unrecorded_checkout_reservations(integer) to service_role;

notify pgrst, 'reload schema';
