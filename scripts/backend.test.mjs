import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const database = new PGlite({ extensions: { pgcrypto } });
const customer = '10000000-0000-4000-8000-000000000001';
const merchant = '10000000-0000-4000-8000-000000000002';
const outsider = '10000000-0000-4000-8000-000000000003';
let fixture;

before(async () => {
  // Recreate the Auth claims and application roles Supabase supplies to PostgREST.
  await database.exec(`
    create schema extensions;
    create schema auth;
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true), '')::uuid
    $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims',true), ''), '{}')::jsonb
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
  `);
  const migrations = new URL('../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
    await database.exec(await readFile(new URL(file, migrations), 'utf8'));
  }
  await database.exec(await readFile(new URL('../supabase/seed.sql', import.meta.url), 'utf8'));
  await database.query('insert into auth.users(id) values ($1),($2),($3)', [customer, merchant, outsider]);
  const { rows: [row] } = await database.query(`
    select r.id as restaurant, c.id as item, c.price_cents, s.id as slot
    from restaurants r join pickup_slots s on s.restaurant_id = r.id
    join slot_item_inventory i on i.slot_id = s.id
    join catalog_items c on c.id = i.item_id
    where s.cutoff_at > now()
    order by s.starts_at, r.name, c.name limit 1
  `);
  assert.ok(row, 'Demo catalog has an available pickup slot');
  fixture = row;
  await database.query(`insert into merchant_memberships(user_id,restaurant_id,role) values($1,$2,'owner')`, [merchant, row.restaurant]);
});

after(async () => database.close());

async function withRole(role, user, operation) {
  return database.transaction(async (tx) => {
    await tx.exec(role === 'anon' ? 'set local role anon' : 'set local role authenticated');
    await tx.query(`select set_config('request.jwt.claim.sub',$1,true)`, [user ?? '']);
    return operation(tx);
  });
}

function order(tx, key, overrides = {}) {
  const { restaurant, slot, item, mode = 'counter', vehicle = {}, quantity = 2 } = { ...fixture, ...overrides };
  return tx.query('select * from create_order($1,$2,$3,$4,$5,$6)', [
    restaurant, slot, key, mode, JSON.stringify(vehicle), JSON.stringify([{ item_id: item, quantity }]),
  ]).then(({ rows }) => rows[0]);
}

test('anonymous waitlist is idempotent and catalog is readable', async () => {
  await withRole('anon', null, async (tx) => {
    await tx.query(`select join_waitlist('Diner@example.com','customer')`);
    await tx.query(`select join_waitlist('diner@example.com','customer')`);
    const { rows } = await tx.query('select id from catalog_items');
    assert.ok(rows.length > 0);
  });
  const { rows } = await database.query(`select email from waitlist_entries where lower(email) = 'diner@example.com'`);
  assert.deepEqual(rows, [{ email: 'diner@example.com' }]);
  await assert.rejects(withRole('anon', null, (tx) => tx.query('select * from waitlist_entries')), /permission denied/);
});

test('an order reserves stock once, prices on the server and is visible only to assigned actors', async () => {
  const created = await withRole('authenticated', customer, (tx) => order(tx, 'test-order-1'));
  const retry = await withRole('authenticated', customer, (tx) => order(tx, 'test-order-1'));
  assert.equal(created.id, retry.id);
  assert.equal(created.subtotal_cents, fixture.price_cents * 2);
  await assert.rejects(withRole('authenticated', customer, (tx) => order(tx, 'test-order-1', { quantity: 1 })), /already used|different/);
  const { rows: [stock] } = await database.query(`select reserved_qty from slot_item_inventory where slot_id=$1 and item_id=$2`, [fixture.slot, fixture.item]);
  assert.equal(stock.reserved_qty, 2);
  const { rows } = await withRole('authenticated', outsider, (tx) => tx.query('select * from orders where id=$1', [created.id]));
  assert.equal(rows.length, 0);
  await assert.rejects(withRole('authenticated', outsider, (tx) => tx.query("select update_order_status($1,'accepted')", [created.id])), /authorized/);
  await withRole('authenticated', merchant, (tx) => tx.query("select update_order_status($1,'cancelled')", [created.id]));
  const { rows: [restored] } = await database.query(`select reserved_qty from slot_item_inventory where slot_id=$1 and item_id=$2`, [fixture.slot, fixture.item]);
  assert.equal(restored.reserved_qty, 0);
});

test('checkout rejects sold-out stock, a missed cutoff and unavailable curbside', async () => {
  await assert.rejects(withRole('authenticated', customer, (tx) => order(tx, 'test-stock-1', { quantity: 50 })), /stock|availability/);
  await database.query('update restaurants set curbside_enabled=false where id=$1', [fixture.restaurant]);
  await assert.rejects(withRole('authenticated', customer, (tx) => order(tx, 'test-curbside-1', { mode: 'curbside' })), /curbside/);
  await assert.rejects(database.query(`update pickup_slots set cutoff_at=now()-interval '1 second' where id=$1`, [fixture.slot]), /cannot reschedule/);
  const { rows: [closed] } = await database.query(`
    insert into pickup_slots (restaurant_id, starts_at, ends_at, cutoff_at, capacity)
    values ($1, now()+interval '2 seconds', now()+interval '1 hour', now()-interval '1 second', 10)
    returning id
  `, [fixture.restaurant]);
  await assert.rejects(withRole('authenticated', customer, (tx) => order(tx, 'test-cutoff-1', { slot: closed.id })), /closed|cutoff/);
});

test('behavioral analytics requires an explicit opt-in', async () => {
  const track = (tx) => tx.query("select track_event('restaurant_view',$1,'{}')", [fixture.restaurant]);
  await assert.rejects(withRole('authenticated', customer, track), /consent/);
  await database.query("insert into consent_records (user_id,consent_type,policy_version,consent_action) values ($1,'analytics','2026-11-13','granted')", [customer]);
  await withRole('authenticated', customer, track);
  await database.query("insert into consent_records (user_id,consent_type,policy_version,consent_action) values ($1,'analytics','2026-11-13','revoked')", [customer]);
  await assert.rejects(withRole('authenticated', customer, track), /consent/);
});

test('only authorized merchants can publish the reviewed revision', async () => {
  const { rows: [draft] } = await withRole('authenticated', merchant, (tx) => tx.query(`
    insert into prep_drafts (catalog_item_id, restaurant_id, name, source_steps)
    select id, restaurant_id, name, array['Chef source step'] from catalog_items where id = $1
    returning id, updated_at::text
  `, [fixture.item]));
  const publish = (tx, revision) => tx.query('select * from publish_prep_draft($1,$2,$3)', [draft.id, revision, ['Reviewed instruction']]);
  await assert.rejects(withRole('authenticated', outsider, (tx) => publish(tx, draft.updated_at)), /authorized/);
  await assert.rejects(withRole('anon', null, (tx) => tx.query('select * from prep_drafts')), /permission denied/);
  await assert.rejects(withRole('authenticated', merchant, (tx) => tx.query('update catalog_items set published_steps=$1 where id=$2', [['Bypass'], fixture.item])), /permission denied/);
  await withRole('authenticated', merchant, (tx) => tx.query('update prep_drafts set source_steps=$1 where id=$2', [['New chef wording'], draft.id]));
  await assert.rejects(withRole('authenticated', merchant, (tx) => publish(tx, draft.updated_at)), /draft changed/);
  const { rows: [latest] } = await database.query('select updated_at::text from prep_drafts where id=$1', [draft.id]);
  await withRole('authenticated', merchant, (tx) => publish(tx, latest.updated_at));
  const { rows: [published] } = await withRole('anon', null, (tx) => tx.query('select published_steps from catalog_items where id=$1', [fixture.item]));
  assert.deepEqual(published.published_steps, ['Reviewed instruction']);
});
