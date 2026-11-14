-- Retryable claims for overdue, recorded Stripe Checkout Sessions.
-- The worker only retrieves provider state; it never creates or expires a session.
alter table public.order_checkout_sessions
  add column if not exists reconcile_after timestamptz,
  add column if not exists reconcile_attempts integer not null default 0 check (reconcile_attempts >= 0),
  add column if not exists reconcile_claim_id uuid,
  add column if not exists reconcile_claimed_until timestamptz;

update public.order_checkout_sessions
set reconcile_after = expires_at
where status = 'open' and stripe_session_id is not null and reconcile_after is null;

create index if not exists order_checkout_sessions_reconcile_due_idx
  on public.order_checkout_sessions((coalesce(reconcile_after,expires_at)), expires_at, order_id)
  where status = 'open' and stripe_session_id is not null;

create or replace function public.claim_due_checkout_reconciliations(
  p_limit integer default 20,
  p_lease_seconds integer default 60
) returns setof jsonb
language plpgsql security definer set search_path=public,auth as $$
begin
  if p_limit is null or p_lease_seconds is null
    or p_limit not between 1 and 100 or p_lease_seconds not between 10 and 600 then
    raise exception 'invalid reconciliation claim bounds';
  end if;
  return query
  with due as (
    select s.order_id
    from public.order_checkout_sessions s
    where s.status='open' and s.stripe_session_id is not null
      and s.expires_at<=clock_timestamp()
      and coalesce(s.reconcile_after,s.expires_at)<=clock_timestamp()
      and (s.reconcile_claimed_until is null or s.reconcile_claimed_until<=clock_timestamp())
    order by coalesce(s.reconcile_after,s.expires_at),s.expires_at,s.order_id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.order_checkout_sessions s
    set reconcile_claim_id=gen_random_uuid(),
        reconcile_claimed_until=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    from due d where s.order_id=d.order_id
    returning s.*
  )
  select jsonb_build_object(
    'claim_id',c.reconcile_claim_id,
    'order_id',c.order_id,
    'session_id',c.stripe_session_id,
    'stripe_account_id',c.stripe_account_id,
    'amount_cents',c.amount_cents,
    'subtotal_cents',c.subtotal_cents,
    'discount_cents',c.discount_cents,
    'promo_code',c.promo_code_snapshot,
    'discount_percent',c.discount_percent,
    'application_fee_cents',c.application_fee_cents,
    'currency',c.currency,
    'expires_at',c.expires_at,
    'status','pending'
  ) from claimed c;
end $$;

create or replace function public.finish_checkout_reconciliation(
  p_order_id uuid,
  p_claim_id uuid,
  p_retry boolean default false
) returns boolean
language plpgsql security definer set search_path=public,auth as $$
declare s public.order_checkout_sessions%rowtype; delay_seconds integer;
begin
  if p_order_id is null or p_claim_id is null then return false; end if;
  select * into s from public.order_checkout_sessions where order_id=p_order_id for update;
  if not found or s.reconcile_claim_id is distinct from p_claim_id then return false; end if;
  if p_retry then
    delay_seconds:=least(3600,30 * (2 ^ least(s.reconcile_attempts,7))::integer);
    update public.order_checkout_sessions set
      reconcile_attempts=reconcile_attempts+1,
      reconcile_after=clock_timestamp()+make_interval(secs=>delay_seconds),
      reconcile_claim_id=null,reconcile_claimed_until=null,updated_at=now()
    where order_id=p_order_id;
  else
    if s.status='open' or exists(select 1 from public.orders o where o.id=p_order_id and o.payment_status='pending') then
      raise exception 'checkout reconciliation is not terminal';
    end if;
    update public.order_checkout_sessions set
      reconcile_after=null,reconcile_claim_id=null,reconcile_claimed_until=null,updated_at=now()
    where order_id=p_order_id;
  end if;
  return true;
end $$;

revoke all on function public.claim_due_checkout_reconciliations(integer,integer) from public,anon,authenticated;
revoke all on function public.finish_checkout_reconciliation(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.claim_due_checkout_reconciliations(integer,integer) to service_role;
grant execute on function public.finish_checkout_reconciliation(uuid,uuid,boolean) to service_role;

notify pgrst, 'reload schema';
