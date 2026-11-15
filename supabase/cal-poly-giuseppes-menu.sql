-- Refresh the two Giuseppe’s demo photos and the Carbonara recipe and garnish choice.
begin;

with photos(item_name, image_key) as (values
  ('Carbonara Kit', 'giuseppes-carbonara'),
  ('Pomodoro Kit', 'giuseppes-pomodoro')
)
update public.catalog_items i
set image_key = p.image_key, updated_at = now()
from public.restaurants r, photos p
where r.id = i.restaurant_id and r.slug = 'cal-poly-giuseppes'
  and i.name = p.item_name and i.active and i.published_at is not null
  and i.image_key is distinct from p.image_key;

with carbonara as (
  select i.id, i.restaurant_id, array[
    '8 min · Bring a pot of water to a boil. Add the noodles and cook until just tender. Save ¼ cup of the cooking water, then drain.',
    '3 min · Return the noodles to the pot over low heat. Toss with the carbonara sauce and the ¼ cup of reserved water until coated.',
    '3 min · Fold in the cooked pancetta and stir gently until steaming hot.',
    '1 min · Divide into bowls and finish with the garnish.'
  ] as steps,
  '[{"id":"finish","name":"Garnish","min":0,"max":1,"choices":[{"id":"included","name":"Include garnish"}]}]'::jsonb as options
  from public.catalog_items i
  join public.restaurants r on r.id = i.restaurant_id
  where r.slug = 'cal-poly-giuseppes' and i.name = 'Carbonara Kit'
    and i.active and i.published_at is not null
), published as (
  update public.catalog_items i
  set published_steps = c.steps, prep_minutes = 15, option_groups = c.options, updated_at = now()
  from carbonara c
  where i.id = c.id and (i.published_steps is distinct from c.steps or i.prep_minutes is distinct from 15
    or i.option_groups is distinct from c.options)
)
update public.order_items oi
set prep_steps_snapshot = c.steps
from carbonara c
join public.orders o on o.restaurant_id = c.restaurant_id
join auth.users u on u.id = o.user_id
where oi.order_id = o.id and oi.item_id = c.id
  and u.email = 'demo-calpoly-customer@cena.test' and u.raw_user_meta_data->>'cena_demo' = 'cal-poly'
  and o.request_hash = 'cal-poly-demo' and o.payment_method = 'pay_at_pickup'
  and oi.prep_steps_snapshot is distinct from c.steps;

commit;
