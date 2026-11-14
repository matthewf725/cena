-- Create a pickup window and its per-item stock atomically through the merchant app.
-- SECURITY INVOKER preserves the existing table grants and row-level policies.
create or replace function public.create_pickup_slot_with_inventory(
  p_restaurant_id uuid,
  p_item_ids uuid[],
  p_starts_at timestamptz,
  p_window_minutes integer,
  p_cutoff_minutes integer,
  p_capacity integer
) returns uuid
language plpgsql security invoker set search_path=public,auth as $$
declare
  v_slot_id uuid;
begin
  if auth.uid() is null or not public.is_restaurant_member(p_restaurant_id) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  if p_starts_at is null or p_starts_at <= clock_timestamp() + make_interval(mins => coalesce(p_cutoff_minutes,0)) then
    raise exception 'pickup window must start after its order cutoff';
  end if;
  if p_window_minutes is null or p_window_minutes not between 5 and 180 then
    raise exception 'pickup window duration must be between 5 and 180 minutes';
  end if;
  if p_cutoff_minutes is null or p_cutoff_minutes not between 0 and 240 then
    raise exception 'order cutoff must be between 0 and 240 minutes before pickup';
  end if;
  if p_capacity is null or p_capacity not between 1 and 500 then
    raise exception 'pickup capacity must be between 1 and 500 orders';
  end if;

  insert into public.pickup_slots(restaurant_id,starts_at,ends_at,cutoff_at,capacity)
  values(
    p_restaurant_id,
    p_starts_at,
    p_starts_at + make_interval(mins => p_window_minutes),
    p_starts_at - make_interval(mins => p_cutoff_minutes),
    p_capacity
  ) returning id into v_slot_id;

  if cardinality(coalesce(p_item_ids,'{}'::uuid[])) > 0 then
    insert into public.slot_item_inventory(slot_id,item_id,available_qty)
    select v_slot_id,requested.item_id,8
    from unnest(p_item_ids) as requested(item_id);
  end if;

  return v_slot_id;
end;
$$;

revoke all on function public.create_pickup_slot_with_inventory(uuid,uuid[],timestamptz,integer,integer,integer) from public,anon;
grant execute on function public.create_pickup_slot_with_inventory(uuid,uuid[],timestamptz,integer,integer,integer) to authenticated;

notify pgrst, 'reload schema';
