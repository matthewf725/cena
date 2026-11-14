-- Keep the owner lookup contract aligned with reserve_checkout_order so Go can
-- validate an existing Stripe session for both discounted and full-price orders.
create or replace function public.get_checkout_for_owner(p_order_id uuid,p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,auth as $$
declare o public.orders%rowtype; s public.order_checkout_sessions%rowtype;
begin
  select * into o from public.orders where id=p_order_id and user_id=p_user_id;
  if not found then raise exception 'order not found' using errcode='42501'; end if;
  select * into s from public.order_checkout_sessions where order_id=p_order_id;
  if not found then raise exception 'checkout not found'; end if;
  return jsonb_build_object('order_id',o.id,'status',o.payment_status,'payment_status',o.payment_status,
    'order_status',o.status,'session_id',s.stripe_session_id,'stripe_account_id',s.stripe_account_id,
    'amount_cents',s.amount_cents,'subtotal_cents',s.subtotal_cents,'discount_cents',s.discount_cents,
    'promo_code',s.promo_code_snapshot,'discount_percent',s.discount_percent,
    'application_fee_cents',s.application_fee_cents,'currency',s.currency,'expires_at',s.expires_at);
end $$;

revoke all on function public.get_checkout_for_owner(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_checkout_for_owner(uuid,uuid) to service_role;

notify pgrst, 'reload schema';
