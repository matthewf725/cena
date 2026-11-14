-- Run in the cloud SQL editor after creating the five Cal Poly demo Auth users.
-- Public menu sources: lunaredslo.com, mamasmeatball.com/menu,
-- piadinaslo.com/menus/lunch-dinner/, giuseppesrestaurant.com/giuseppes-cucina-rustica/.
-- This seed models sample kits, pickup windows, and order history for a walkthrough.
begin;

do $$
begin
  if (select count(*) from auth.users where raw_user_meta_data->>'cena_demo' = 'cal-poly'
    and email in ('demo-calpoly-customer@cena.test','demo-calpoly-luna-red@cena.test',
      'demo-calpoly-mamas-meatball@cena.test','demo-calpoly-piadina@cena.test','demo-calpoly-giuseppes@cena.test')) <> 5 then
    raise exception 'Create the five Cal Poly demo Auth accounts first';
  end if;
end $$;

insert into public.restaurants (slug,name,description,cuisine,image_key,address,curbside_enabled,latitude,longitude,active)
values
 ('cal-poly-luna-red','Luna Red','Cal Poly demo menu inspired by Luna Red’s paella and Latin cooking.','Latin','tacos','1023 Chorro St, San Luis Obispo, CA 93401',false,35.2801,-120.6636,true),
 ('cal-poly-mamas-meatball','Mama’s Meatball','Cal Poly demo menu inspired by Mama’s Meatball’s Pugliese cooking.','Italian','rigatoni','570 Higuera St #130, San Luis Obispo, CA 93401',false,35.2769,-120.6659,true),
 ('cal-poly-piadina','Piadina','Cal Poly demo menu inspired by Piadina at Hotel San Luis Obispo.','Pizza','mediterranean','877 Palm St, San Luis Obispo, CA 93401',false,35.2810,-120.6644,true),
 ('cal-poly-giuseppes','Giuseppe’s Cucina Rustica','Cal Poly demo menu inspired by Giuseppe’s Southern Italian cooking.','Italian','rigatoni','849 Monterey St, San Luis Obispo, CA 93401',false,35.2805,-120.6642,true)
on conflict (slug) do update set name=excluded.name,description=excluded.description,cuisine=excluded.cuisine,
 image_key=excluded.image_key,address=excluded.address,curbside_enabled=excluded.curbside_enabled,
 latitude=excluded.latitude,longitude=excluded.longitude,active=true;

insert into public.merchant_memberships (user_id,restaurant_id,role)
select u.id,r.id,'owner' from public.restaurants r
join auth.users u on u.email='demo-'||replace(r.slug,'cal-poly-','calpoly-')||'@cena.test'
where r.slug in ('cal-poly-luna-red','cal-poly-mamas-meatball','cal-poly-piadina','cal-poly-giuseppes')
on conflict (user_id,restaurant_id) do update set role=excluded.role;

select pg_catalog.set_config('cena.cal_poly_demo_menu', jsonb_agg(to_jsonb(menu))::text, true)
from (values
 ('cal-poly-luna-red','De La Luna Paella Kit','Aji amarillo chicken and chorizo paella with peas.',2400,'tacos','Stovetop',2),
 ('cal-poly-luna-red','Market Vegetable Paella Kit','Vegetable paella with seasonal produce.',2000,'mediterranean','Stovetop',null),
 ('cal-poly-mamas-meatball','Spaghetti Meatball Kit','Spaghetti and Italian meatballs in Bolognese sauce.',2100,'rigatoni','Stovetop',3),
 ('cal-poly-mamas-meatball','Fettuccine Alfredo Kit','Fettuccine with a creamy Alfredo sauce.',1900,'rigatoni','Stovetop',null),
 ('cal-poly-piadina','Classic Cheese Pizza Kit','A cheese pizza to finish in your oven.',2100,'mediterranean','Oven',null),
 ('cal-poly-piadina','Mushroom Pizza Kit','A mushroom pizza to finish in your oven.',2700,'mediterranean','Oven',5),
 ('cal-poly-giuseppes','Carbonara Kit','Pasta with carbonara sauce.',2300,'rigatoni','Stovetop',7),
 ('cal-poly-giuseppes','Pomodoro Kit','Pasta with tomato sauce.',1900,'rigatoni','Stovetop',null)
) as menu(slug,name,description,regular,image_key,equipment,sample_order_day);

with cal_poly_demo_menu as (
 select * from jsonb_to_recordset(current_setting('cena.cal_poly_demo_menu')::jsonb)
 as menu(slug text,name text,description text,regular integer,image_key text,equipment text,sample_order_day integer)
)
insert into public.catalog_items (restaurant_id,name,description,price_cents,regular_price_cents,image_key,
 equipment,category,prep_minutes,option_groups,active,published_at)
select r.id,m.name,m.description,round(m.regular*0.75),m.regular,m.image_key,
 array[m.equipment],'Dinner Kits',15,
 case when m.sample_order_day is null then '[]'::jsonb else
 '[{"id":"finish","name":"Finishing options","min":0,"max":1,"choices":[{"id":"on_side","name":"Garnish on the side"},{"id":"included","name":"Include garnish"}]}]'::jsonb end,
 true,now()
from cal_poly_demo_menu m join public.restaurants r on r.slug=m.slug
on conflict (restaurant_id,lower(name)) do update set description=excluded.description,
 price_cents=excluded.price_cents,regular_price_cents=excluded.regular_price_cents,image_key=excluded.image_key,
 equipment=excluded.equipment,option_groups=excluded.option_groups,active=true,published_at=excluded.published_at;

insert into public.pickup_slots (restaurant_id,starts_at,ends_at,cutoff_at,capacity,active)
select r.id,s.starts_at,s.starts_at+interval '30 minutes',s.starts_at-interval '30 minutes',16,true
from public.restaurants r cross join generate_series(0,35) as d(day_offset)
cross join (values (time '12:30'),(time '15:30'),(time '17:30'),(time '19:00')) t(local_time)
cross join lateral (select ((now() at time zone r.timezone)::date+d.day_offset+t.local_time) at time zone r.timezone as starts_at) s
where r.slug in ('cal-poly-luna-red','cal-poly-mamas-meatball','cal-poly-piadina','cal-poly-giuseppes')
 and s.starts_at-interval '30 minutes'>now()
on conflict (restaurant_id,starts_at) do nothing;

with cal_poly_demo_menu as (
 select * from jsonb_to_recordset(current_setting('cena.cal_poly_demo_menu')::jsonb) as menu(slug text,name text)
)
insert into public.slot_item_inventory (slot_id,item_id,available_qty)
select s.id,i.id,12 from public.pickup_slots s join public.restaurants r on r.id=s.restaurant_id
join cal_poly_demo_menu m on m.slug=r.slug
join public.catalog_items i on i.restaurant_id=r.id and i.name=m.name
where s.active and s.cutoff_at>now()
on conflict (slot_id,item_id) do nothing;

with cal_poly_demo_menu as (
 select * from jsonb_to_recordset(current_setting('cena.cal_poly_demo_menu')::jsonb) as menu(slug text,sample_order_day integer)
)
insert into public.pickup_slots (restaurant_id,starts_at,ends_at,cutoff_at,capacity,reserved_count,active)
select r.id,s.starts_at,s.starts_at+interval '30 minutes',s.starts_at-interval '30 minutes',16,1,false
from public.restaurants r join cal_poly_demo_menu m on m.slug=r.slug and m.sample_order_day is not null
cross join lateral (select ((now() at time zone r.timezone)::date-m.sample_order_day+time '18:00') at time zone r.timezone as starts_at) s
on conflict (restaurant_id,starts_at) do nothing;

with cal_poly_demo_menu as (
 select * from jsonb_to_recordset(current_setting('cena.cal_poly_demo_menu')::jsonb) as menu(slug text,name text,sample_order_day integer)
), inserted as (
 insert into public.orders (user_id,restaurant_id,slot_id,idempotency_key,status,request_hash,pickup_starts_at,
  pickup_ends_at,restaurant_timezone,subtotal_cents,payment_method,payment_status,created_at,updated_at)
 select u.id,r.id,s.id,'cal-poly-demo-'||m.slug,'completed','cal-poly-demo',s.starts_at,s.ends_at,
  r.timezone,i.price_cents,'pay_at_pickup','pay_at_pickup',s.starts_at-interval '2 hours',s.ends_at
 from cal_poly_demo_menu m join public.restaurants r on r.slug=m.slug
 join public.catalog_items i on i.restaurant_id=r.id and i.name=m.name
 join public.pickup_slots s on s.restaurant_id=r.id and s.starts_at=
  (((now() at time zone r.timezone)::date-m.sample_order_day+time '18:00') at time zone r.timezone)
 join auth.users u on u.email='demo-calpoly-customer@cena.test'
 where m.sample_order_day is not null
 on conflict (user_id,idempotency_key) do nothing
 returning id,restaurant_id
)
insert into public.order_items (order_id,item_id,name_snapshot,unit_price_cents,quantity,prep_steps_snapshot,options_snapshot)
select o.id,i.id,i.name,i.price_cents,1,i.published_steps,
 jsonb_build_array(jsonb_build_object('quantity',1,'groups',
   public.normalize_catalog_option_selections(i.option_groups,'{"finish":["on_side"]}'::jsonb)))
from inserted o join public.restaurants r on r.id=o.restaurant_id
join cal_poly_demo_menu m on m.slug=r.slug and m.sample_order_day is not null
join public.catalog_items i on i.restaurant_id=r.id and i.name=m.name;

-- Retire the previous San Francisco fixtures while preserving any history that refers to them.
update public.restaurants set active=false
where slug in ('cena-demo-harbor-hearth','cena-demo-little-fig','cena-demo-sunrise');

commit;

select r.name, count(distinct i.id) as kits, count(distinct s.id) as upcoming_slots,
 count(distinct mm.user_id) as merchant_accounts, count(distinct o.id) as demo_orders
from public.restaurants r
left join public.catalog_items i on i.restaurant_id=r.id and i.active
left join public.pickup_slots s on s.restaurant_id=r.id and s.active and s.cutoff_at>now()
left join public.merchant_memberships mm on mm.restaurant_id=r.id
left join public.orders o on o.restaurant_id=r.id and o.request_hash='cal-poly-demo'
where r.slug in ('cal-poly-luna-red','cal-poly-mamas-meatball','cal-poly-piadina','cal-poly-giuseppes')
group by r.name order by r.name;
