import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const database = new PGlite({ extensions: { pgcrypto } });
let sampleRestaurant;
const comparisonCustomer = '10000000-0000-4000-8000-000000000004';

before(async () => {
  await database.exec(`
    create schema extensions; create schema auth;
    create role anon; create role authenticated; create role service_role bypassrls;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    grant usage on schema auth to anon,authenticated,service_role;
  `);
  const migrations = new URL('../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
    await database.exec(await readFile(new URL(file, migrations), 'utf8'));
  }
  await database.exec(await readFile(new URL('../supabase/seed.sql', import.meta.url), 'utf8'));
  await database.query('insert into auth.users(id) values($1)', [comparisonCustomer]);

  // Local-only fixtures broaden cuisine paging without adding fake production seed data.
  await database.query(`
    insert into restaurants(slug,name,cuisine,description,timezone,latitude,longitude)
    select 'qa-cuisine-'||n,'QA Restaurant '||n,'Cuisine '||lpad(n::text,2,'0'),'Local test fixture','America/Los_Angeles',37.78+n/10000.0,-122.42
    from generate_series(1,10) n;
  `);
  await database.query(`
    insert into catalog_items(restaurant_id,name,description,price_cents,regular_price_cents,published_at)
    select id,'Fixture Meal '||slug,'local fixture menu item',1000,1330,now() from restaurants where slug like 'qa-cuisine-%';
  `);
  await database.query(`
    insert into pickup_slots(restaurant_id,starts_at,ends_at,cutoff_at,capacity)
    select id,now()+interval '3 hours',now()+interval '3 hours 30 minutes',now()+interval '2 hours 45 minutes',10
    from restaurants where slug like 'qa-cuisine-%';
  `);
  await database.query(`
    insert into slot_item_inventory(slot_id,item_id,available_qty)
    select s.id,i.id,5 from pickup_slots s join catalog_items i on i.restaurant_id=s.restaurant_id
    join restaurants r on r.id=s.restaurant_id where r.slug like 'qa-cuisine-%';
  `);
  const { rows: [row] } = await database.query("select id from restaurants where slug='sunrise-cafe'");
  sampleRestaurant = row.id;
});

after(async () => database.close());

async function feed(lat = null, lon = null, after = null, query = null, cuisine = null, recent = []) {
  const { rows: [row] } = await database.query(
    'select discover_pickup_feed($1,$2,$3,$4,$5,$6) as feed', [lat, lon, after, query, cuisine, recent],
  );
  return row.feed;
}

async function asAnon(operation) {
  return database.transaction(async (tx) => {
    await tx.exec('set local role anon');
    await tx.query("select set_config('request.jwt.claim.sub','',true)");
    return operation(tx);
  });
}

async function asCustomer(operation) {
  return database.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [comparisonCustomer]);
    return operation(tx);
  });
}

test('discovery pages lexicographic cuisine rails without returning menu dumps', async () => {
  const first = await feed();
  assert.equal(first.categories.length, 4);
  assert.ok(first.next_cursor);
  const second = await feed(null, null, first.next_cursor);
  assert.equal(second.categories.length, 4);
  assert.ok(second.next_cursor);
  const third = await feed(null, null, second.next_cursor);
  assert.equal(third.categories.length, 4);
  assert.equal(third.next_cursor, null);
  const keys = [...first.categories, ...second.categories, ...third.categories].map((c) => c.name.toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
  for (const rail of [...first.categories, ...second.categories, ...third.categories]) {
    assert.ok(rail.restaurants.length > 0 && rail.restaurants.length <= 8);
    for (const restaurant of rail.restaurants) {
      assert.ok(restaurant.id && restaurant.next_slot?.id);
      assert.equal('items' in restaurant, false);
      assert.equal('menu' in restaurant, false);
    }
  }
  assert.ok(first.explore.length <= 8);
  for (const item of first.explore) assert.ok(item.restaurant?.id && item.meal?.id);
});

test('anonymous discovery RPC respects public row policies', async () => {
  const { rows: [row] } = await asAnon((tx) => tx.query("select discover_pickup_feed(null,null,null,null,null,'{}') as feed"));
  assert.ok(row.feed.nearby.length > 0);
  assert.ok(row.feed.categories.length > 0);
  assert.ok(row.feed.explore.every((entry) => entry.meal.id && entry.restaurant.id));
});

test('prepared meal total is explicit and does not change kit checkout price', async () => {
  const { rows: [rigatoni] } = await database.query(`
    select id,price_cents,regular_price_cents,prepared_meal_total_cents from catalog_items
    where name='Rigatoni alla Vodka Kit'
  `);
  assert.equal(rigatoni.price_cents,1695);
  assert.equal(rigatoni.regular_price_cents,2260);
  assert.equal(rigatoni.prepared_meal_total_cents,2455);
  const { rows: [taco] } = await database.query(`
    select prepared_meal_total_cents,regular_price_cents from catalog_items where name='Baja Chicken Taco Kit'
  `);
  assert.equal(taco.prepared_meal_total_cents,null);
  assert.equal(taco.regular_price_cents,2125);

  const preparedFeed = await feed(null,null,null,'Rigatoni');
  assert.equal(preparedFeed.explore[0].meal.prepared_meal_total_cents,2455);
  const unpricedFeed = await feed(null,null,null,'Taco');
  assert.equal(unpricedFeed.explore[0].meal.prepared_meal_total_cents,null);

  const { rows: [order] } = await database.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [comparisonCustomer]);
    return tx.query(`
      with fixture as (
        select ci.id as item_id,ci.restaurant_id,s.id as slot_id
        from catalog_items ci join pickup_slots s on s.restaurant_id=ci.restaurant_id
        where ci.name='Rigatoni alla Vodka Kit' and s.cutoff_at>now() order by s.starts_at limit 1
      )
      select created.* from fixture f cross join lateral create_order(f.restaurant_id,f.slot_id,'prepared-total-test','counter','{}',
        jsonb_build_array(jsonb_build_object('item_id',f.item_id,'quantity',1))) created
    `);
  });
  assert.ok(order, 'order fixture exists');
  assert.equal(order.subtotal_cents,1695);
  const { rows: [snapshot] } = await database.query('select unit_price_cents from order_items where order_id=$1', [order.id]);
  assert.equal(snapshot.unit_price_cents,1695);
});

test('discovery computes true miles, filters search and shows sold-out recent restaurants', async () => {
  const nearby = await feed(37.7909,-122.3967);
  const sunrise = nearby.nearby.find((r) => r.id === sampleRestaurant);
  assert.ok(sunrise);
  assert.equal(typeof sunrise.distance_miles, 'number');
  assert.ok(sunrise.distance_miles < 1);
  const noLocation = await feed();
  assert.equal(noLocation.nearby[0].distance_miles, null);
  const outsideMarket = await feed(34.0522,-118.2437,null,null,null,[sampleRestaurant]);
  assert.equal(outsideMarket.nearby.length, 0);
  assert.equal(outsideMarket.categories.length, 0);
  assert.equal(outsideMarket.explore.length, 0);
  assert.equal(outsideMarket.recent[0].id, sampleRestaurant);

  const search = await feed(null,null,null,'Rigatoni');
  assert.ok(search.nearby.some((r) => r.id === sampleRestaurant));
  assert.ok(search.explore.some((x) => x.meal.name === 'Rigatoni alla Vodka Kit'));
  const filtered = await feed(null,null,null,null,'Mediterranean');
  assert.ok(filtered.categories.every((c) => c.name === 'Mediterranean'));

  await database.query(`update slot_item_inventory set available_qty=reserved_qty where item_id in (select id from catalog_items where restaurant_id=$1)`, [sampleRestaurant]);
  const recents = await feed(null,null,null,null,null,[sampleRestaurant]);
  const recent = recents.recent.find((r) => r.id === sampleRestaurant);
  assert.ok(recent);
  assert.equal(recent.next_slot, null);
  assert.equal(recents.nearby.some((r) => r.id === sampleRestaurant), false);
});
