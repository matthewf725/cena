-- Run after cal-poly-demo.sql, or on its own to refresh an existing demo.
-- AI-drafted steps are specific to the sample kits and defer cooking settings to the kit labels.
begin;

with demo_steps(slug, item_name, steps) as (values
  ('cal-poly-luna-red', 'De La Luna Paella Kit', array[
    'Check the kit labels for how to prepare the rice, ají amarillo chicken, and chorizo. Follow the directions for each component if they are packed separately.',
    'Finish the paella on the stovetop as directed. Fold in the peas where the label calls for them.',
    'Portion the paella and add any garnish packed separately just before serving.'
  ]),
  ('cal-poly-luna-red', 'Market Vegetable Paella Kit', array[
    'Read the kit directions for the paella and any seasonal vegetables packed separately.',
    'Finish the paella on the stovetop using the kit settings. Fold in the seasonal vegetables when the kit directs.',
    'Divide the paella among plates and add any finishing ingredients included with the kit.'
  ]),
  ('cal-poly-mamas-meatball', 'Spaghetti Meatball Kit', array[
    'Prepare the spaghetti according to its package. Drain it if the directions call for boiling.',
    'Prepare the meatballs and Bolognese on the stovetop as directed on their containers.',
    'Toss the spaghetti with the Bolognese, top with the meatballs, and add any separate garnish at the table.'
  ]),
  ('cal-poly-mamas-meatball', 'Fettuccine Alfredo Kit', array[
    'Prepare the fettuccine according to its package. Drain it if the directions call for boiling.',
    'Warm the Alfredo sauce on the stovetop as the kit directs, stirring gently.',
    'Toss the fettuccine with the sauce until the ribbons are coated, then serve.'
  ]),
  ('cal-poly-piadina', 'Classic Cheese Pizza Kit', array[
    'Preheat the oven to the temperature on the pizza kit label.',
    'Follow the label for assembly if the cheese comes separately, then bake on the recommended tray or rack for the listed time.',
    'Let the pizza rest if the label calls for it, then slice.'
  ]),
  ('cal-poly-piadina', 'Mushroom Pizza Kit', array[
    'Preheat the oven to the temperature on the pizza kit label.',
    'Follow the label for when to add any separately packed mushrooms or other toppings. Bake on the recommended tray or rack for the listed time.',
    'Add any finishing garnish as directed. Let the pizza rest if the label calls for it, then slice.'
  ]),
  ('cal-poly-giuseppes', 'Carbonara Kit', array[
    'Prepare the pasta on the stovetop according to its package.',
    'Check the carbonara sauce label for when and how to combine it with the pasta. Follow the listed heat setting so the sauce finishes as intended.',
    'Toss until the pasta is coated, then serve with any finishing garnish included in the kit.'
  ]),
  ('cal-poly-giuseppes', 'Pomodoro Kit', array[
    'Prepare the pasta according to its package. Drain it if the directions call for boiling.',
    'Warm the pomodoro sauce on the stovetop according to the kit label, stirring as directed.',
    'Toss the pasta with the tomato sauce and add any toppings that came separately.'
  ])
), demo_items as (
  select i.id, i.restaurant_id, d.steps
  from demo_steps d
  join public.restaurants r on r.slug=d.slug and r.active
  join public.catalog_items i on i.restaurant_id=r.id and i.name=d.item_name
    and i.active and i.published_at is not null
), published as (
  update public.catalog_items i
  set published_steps=d.steps, updated_at=now()
  from demo_items d
  where i.id=d.id and cardinality(i.published_steps)=0
  returning i.id, i.published_steps
), legacy_snapshots(steps) as (values
  (array[
    'Follow the kit label for oven settings and heating time.',
    'Arrange the pizza on the recommended tray and heat as directed.',
    'Finish with any toppings packed separately, then slice.'
  ]),
  (array[
    'Check the kit label for the reheating directions for each container.',
    'Warm the paella as directed on the kit and stir gently before serving.',
    'Add the finishing ingredients packed with the kit.'
  ]),
  (array[
    'Check the kit label for the reheating directions for each container.',
    'Warm the pasta and sauce as directed, then toss just before serving.',
    'Finish with the garnish packed separately.'
  ])
)
update public.order_items oi
set prep_steps_snapshot=coalesce(p.published_steps,i.published_steps)
from demo_items d
join public.catalog_items i on i.id=d.id
left join published p on p.id=i.id
join public.orders o on o.restaurant_id=d.restaurant_id
join auth.users u on u.id=o.user_id
where oi.order_id=o.id and oi.item_id=d.id
  and u.email='demo-calpoly-customer@cena.test' and u.raw_user_meta_data->>'cena_demo'='cal-poly'
  and o.request_hash='cal-poly-demo' and o.payment_method='pay_at_pickup'
  and (cardinality(oi.prep_steps_snapshot)=0 or oi.prep_steps_snapshot in (select steps from legacy_snapshots))
  and cardinality(coalesce(p.published_steps,i.published_steps))>0
  and oi.prep_steps_snapshot is distinct from coalesce(p.published_steps,i.published_steps);

commit;
