-- Retain a generated proposal when a merchant edits catalog metadata without
-- changing the chef's source recipe. Source changes still invalidate the proposal.
create or replace function public.save_catalog_item_draft(
  p_catalog_item_id uuid,
  p_restaurant_id uuid,
  p_name text,
  p_description text,
  p_price_cents integer,
  p_regular_price_cents integer,
  p_prepared_meal_total_cents integer,
  p_equipment text[],
  p_allergens text[],
  p_active boolean,
  p_source_steps text[]
) returns table(catalog_item_id uuid, prep_draft_id uuid, draft_updated_at timestamptz)
language plpgsql security invoker set search_path=public,auth as $$
declare
  v_item public.catalog_items%rowtype;
  v_draft public.prep_drafts%rowtype;
  v_has_draft boolean;
  v_source_steps text[]:=coalesce(p_source_steps,'{}'::text[]);
begin
  if auth.uid() is null or not public.is_restaurant_member(p_restaurant_id) then
    raise exception 'not authorized' using errcode='42501';
  end if;

  -- Match publish_prep_draft's draft-then-item lock order to avoid avoidable deadlocks.
  select d.* into v_draft
  from public.prep_drafts d
  where d.catalog_item_id=p_catalog_item_id and d.restaurant_id=p_restaurant_id
  for update;
  v_has_draft := found;

  select * into v_item
  from public.catalog_items
  where id=p_catalog_item_id and restaurant_id=p_restaurant_id
  for update;
  if not found then raise exception 'catalog item unavailable'; end if;

  -- Another writer may have created the first draft while this call waited for the item lock.
  if not v_has_draft then
    select d.* into v_draft
    from public.prep_drafts d
    where d.catalog_item_id=p_catalog_item_id and d.restaurant_id=p_restaurant_id
    for update;
    v_has_draft := found;
  end if;

  update public.catalog_items set
    name=p_name,
    description=coalesce(p_description,description),
    price_cents=p_price_cents,
    regular_price_cents=p_regular_price_cents,
    prepared_meal_total_cents=p_prepared_meal_total_cents,
    equipment=coalesce(p_equipment,'{}'::text[]),
    allergens=coalesce(p_allergens,'{}'::text[]),
    active=coalesce(p_active,false)
  where id=p_catalog_item_id and restaurant_id=p_restaurant_id
  returning * into v_item;

  if v_has_draft then
    update public.prep_drafts set
      name=p_name,
      description=coalesce(p_description,''),
      price_cents=p_price_cents,
      source_steps=v_source_steps,
      generated_steps=case
        when v_source_steps is distinct from v_draft.source_steps then '{}'::text[]
        else v_draft.generated_steps
      end,
      active=coalesce(p_active,true)
    where id=v_draft.id
    returning * into v_draft;
  else
    insert into public.prep_drafts(
      restaurant_id,catalog_item_id,name,description,price_cents,source_steps,generated_steps,active
    ) values (
      p_restaurant_id,p_catalog_item_id,p_name,coalesce(p_description,''),p_price_cents,
      v_source_steps,'{}'::text[],coalesce(p_active,true)
    ) returning * into v_draft;
  end if;

  return query select v_item.id,v_draft.id,v_draft.updated_at;
end;
$$;

revoke all on function public.save_catalog_item_draft(uuid,uuid,text,text,integer,integer,integer,text[],text[],boolean,text[]) from public,anon;
grant execute on function public.save_catalog_item_draft(uuid,uuid,text,text,integer,integer,integer,text[],text[],boolean,text[]) to authenticated;

notify pgrst, 'reload schema';
