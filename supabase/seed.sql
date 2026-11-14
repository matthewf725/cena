-- Demo content is scheduled relative to seed execution, so slots remain in the future.
insert into public.restaurants(slug,name,description,cuisine,image_key,timezone,address,curbside_enabled,latitude,longitude)
values
 ('sunrise-cafe','Sunrise Cafe','Breakfast meal kits packed fresh for pickup.','Cafe','sunrise-cafe-cover','America/Los_Angeles','420 Mission Street, San Francisco, CA',true,37.7909,-122.3967),
 ('little-fig','Little Fig Kitchen','Seasonal Mediterranean meal kits, ready to finish at home.','Mediterranean','little-fig-cover','America/Los_Angeles','88 Valencia Street, San Francisco, CA',true,37.7738,-122.4212)
on conflict(slug) do update set name=excluded.name,description=excluded.description,cuisine=excluded.cuisine,image_key=excluded.image_key,address=excluded.address,curbside_enabled=excluded.curbside_enabled,latitude=excluded.latitude,longitude=excluded.longitude;

insert into public.catalog_items(restaurant_id,name,description,price_cents,regular_price_cents,image_key,category,prep_minutes,equipment,allergens,published_steps,published_at)
select r.id,v.name,v.description,v.price,v.regular,v.image_key,v.category,v.prep,v.equipment,v.allergens,v.steps,now()
from public.restaurants r join (values
 ('sunrise-cafe','Rigatoni alla Vodka Kit','Rigatoni, tomato cream sauce, parmesan, and fresh basil.',1695,2260,'rigatoni','Dinner Kits',15,array['stovetop']::text[],array['wheat','dairy']::text[],array['Boil rigatoni until al dente','Warm tomato cream sauce in a pan','Toss with parmesan and fresh basil']::text[]),
 ('sunrise-cafe','Baja Chicken Taco Kit','Seasoned chicken, warm tortillas, cabbage slaw, and lime crema.',1595,2125,'tacos','Dinner Kits',12,array['stovetop']::text[],array['wheat','dairy']::text[],array['Warm chicken in a skillet','Heat tortillas until soft','Fill with slaw and lime crema']::text[]),
 ('little-fig','Miso Glazed Salmon Kit','Miso glazed salmon, jasmine rice, cucumber, and scallions.',1895,2525,'salmon','Dinner Kits',15,array['oven']::text[],array['fish','soy']::text[],array['Bake salmon until just cooked','Fluff jasmine rice','Serve with cucumber and scallions']::text[]),
 ('little-fig','Mediterranean Chickpea Bowl Kit','Crispy chickpeas, tomato, cucumber, greens, and lemon tahini.',1450,1935,'mediterranean','Dinner Kits',12,array['stovetop']::text[],array['sesame']::text[],array['Crisp chickpeas in a skillet','Toss vegetables and greens','Finish with lemon tahini']::text[])
) as v(slug,name,description,price,regular,image_key,category,prep,equipment,allergens,steps) on r.slug=v.slug
on conflict(restaurant_id,lower(name)) do update set description=excluded.description,price_cents=excluded.price_cents,regular_price_cents=excluded.regular_price_cents,image_key=excluded.image_key,category=excluded.category,prep_minutes=excluded.prep_minutes,equipment=excluded.equipment,allergens=excluded.allergens,published_steps=excluded.published_steps,active=true,published_at=coalesce(catalog_items.published_at,now());

insert into public.pickup_slots(restaurant_id,starts_at,ends_at,cutoff_at,capacity)
select r.id,scheduled.start_at,scheduled.start_at+interval '30 minutes',scheduled.start_at-interval '15 minutes',12
from public.restaurants r cross join generate_series(0,2) as d(day_offset) cross join (values
 (time '11:30'),(time '13:00'),(time '18:00')
) as t(local_time)
cross join lateral (select (date_trunc('day',now() at time zone r.timezone)::date+d.day_offset+t.local_time) at time zone r.timezone as start_at) scheduled
where r.slug in ('sunrise-cafe','little-fig')
and scheduled.start_at-interval '15 minutes' > now()
on conflict(restaurant_id,starts_at) do update set ends_at=excluded.ends_at,cutoff_at=excluded.cutoff_at,capacity=excluded.capacity,active=true;

insert into public.slot_item_inventory(slot_id,item_id,available_qty)
select s.id,i.id,12 from public.pickup_slots s
join public.restaurants r on r.id=s.restaurant_id and r.slug in ('sunrise-cafe','little-fig')
join public.catalog_items i on i.restaurant_id=r.id and i.active
where s.active and s.cutoff_at>now()
on conflict(slot_id,item_id) do update set available_qty=greatest(public.slot_item_inventory.available_qty,excluded.available_qty);
