-- Merchant-managed inventory may be edited, but a row backing a live order is
-- the ledger used for reservation release and must not be removed mid-pickup.
create or replace function public.prevent_delete_inventory_with_live_orders()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if exists (
    select 1 from public.orders o
    join public.order_items i on i.order_id=o.id
    where o.slot_id=old.slot_id and i.item_id=old.item_id
      and o.status not in ('completed','cancelled')
  ) then
    raise exception 'cannot delete inventory with reserved orders';
  end if;
  return old;
end $$;

revoke all on function public.prevent_delete_inventory_with_live_orders() from public,anon,authenticated;
drop trigger if exists protect_live_inventory_delete on public.slot_item_inventory;
create trigger protect_live_inventory_delete before delete on public.slot_item_inventory
  for each row execute function public.prevent_delete_inventory_with_live_orders();

notify pgrst, 'reload schema';
