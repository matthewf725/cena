-- Return the immutable checkout price snapshot for Go's payment-session checks
-- throughout an online refund request and refund webhook reconciliation.
create or replace function public.begin_checkout_refund(p_user_id uuid,p_order_id uuid) returns jsonb
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
    'subtotal_cents',s.subtotal_cents,'discount_cents',s.discount_cents,'promo_code',s.promo_code_snapshot,
    'discount_percent',s.discount_percent,'currency',s.currency,'application_fee_cents',s.application_fee_cents,
    'expires_at',s.expires_at);
end $$;

create or replace function public.checkout_refund_event_context(p_order_id uuid,p_attempt integer,p_account_id text) returns jsonb
language sql stable security definer set search_path=public as $$
  select jsonb_build_object('order_id',s.order_id,'amount_cents',s.amount_cents,'currency',s.currency,
    'subtotal_cents',s.subtotal_cents,'discount_cents',s.discount_cents,'promo_code',s.promo_code_snapshot,
    'discount_percent',s.discount_percent,'application_fee_cents',s.application_fee_cents,
    'stripe_account_id',s.stripe_account_id,'session_id',s.stripe_session_id,'expires_at',s.expires_at,
    'refund_id',f.stripe_refund_id)
  from public.order_checkout_sessions s join public.checkout_refunds f on f.order_id=s.order_id
  where s.order_id=p_order_id and s.stripe_account_id=p_account_id and f.attempt=p_attempt and f.status='pending';
$$;

revoke all on function public.begin_checkout_refund(uuid,uuid) from public,anon,authenticated;
grant execute on function public.begin_checkout_refund(uuid,uuid) to service_role;
revoke all on function public.checkout_refund_event_context(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.checkout_refund_event_context(uuid,integer,text) to service_role;

notify pgrst, 'reload schema';
