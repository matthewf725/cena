import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const database = new PGlite({ extensions: { pgcrypto } });
const customer = '10000000-0000-4000-8000-000000000001';
const merchant = '10000000-0000-4000-8000-000000000002';
const outsider = '10000000-0000-4000-8000-000000000003';
const manager = '10000000-0000-4000-8000-000000000005';
const staff = '10000000-0000-4000-8000-000000000004';
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
  await database.query('insert into auth.users(id) values ($1),($2),($3),($4)', [customer, merchant, outsider, staff]);
  const { rows: [row] } = await database.query(`
    select r.id as restaurant, c.id as item, c.price_cents, s.id as slot
    from restaurants r join pickup_slots s on s.restaurant_id = r.id
    join slot_item_inventory i on i.slot_id = s.id
    join catalog_items c on c.id = i.item_id
    where s.cutoff_at > now() + interval '2 minutes' and s.starts_at > now() + interval '34 minutes'
    order by s.starts_at, r.name, c.name limit 1
  `);
  assert.ok(row, 'Demo catalog has an available pickup slot');
  fixture = row;
  await database.query(`insert into merchant_memberships(user_id,restaurant_id,role) values($1,$2,'owner')`, [merchant, row.restaurant]);
  await database.query(`insert into restaurant_payment_accounts(restaurant_id,stripe_account_id,application_fee_cents,charges_enabled,payouts_enabled) values($1,'acct_fixture',175,true,true)`, [row.restaurant]);
});

after(async () => database.close());

async function withRole(role, user, operation) {
  return database.transaction(async (tx) => {
    await tx.exec(role === 'anon' ? 'set local role anon' : 'set local role authenticated');
    await tx.query(`select set_config('request.jwt.claim.sub',$1,true)`, [user ?? '']);
    return operation(tx);
  });
}

async function withServiceRole(operation) {
  return database.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    return operation(tx);
  });
}

function order(user, key, overrides = {}) {
  const { restaurant, slot, item, mode = 'counter', vehicle = {}, quantity = 2 } = { ...fixture, ...overrides };
  return database.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
    const { rows } = await tx.query('select * from create_order($1,$2,$3,$4,$5,$6)', [
      restaurant, slot, key, mode, JSON.stringify(vehicle), JSON.stringify([{ item_id: item, quantity }]),
    ]);
    return rows[0];
  });
}

test('anonymous waitlist is idempotent and catalog is readable', async () => {
  await withRole('anon', null, async (tx) => {
    await tx.query(`select join_waitlist('Diner@example.com','customer','Would love more pickup windows')`);
    await tx.query(`select join_waitlist('diner@example.com','customer','This retry must not overwrite feedback')`);
    await tx.query(`select join_waitlist('Legacy@example.com','customer')`);
    const { rows } = await tx.query('select id from catalog_items');
    assert.ok(rows.length > 0);
  });
  const { rows } = await database.query(`select email,clarification from waitlist_entries where lower(email) = 'diner@example.com'`);
  assert.deepEqual(rows, [{ email: 'diner@example.com',clarification:'Would love more pickup windows' }]);
  const { rows: [legacy] } = await database.query(`select email,clarification from waitlist_entries where lower(email)='legacy@example.com'`);
  assert.deepEqual(legacy, { email: 'legacy@example.com',clarification:null });
  await assert.rejects(withRole('anon', null, (tx) => tx.query('select join_waitlist($1,$2,$3)', ['long@example.com','customer','x'.repeat(501)])), /too long/);
  await assert.rejects(withRole('anon', null, (tx) => tx.query('select * from waitlist_entries')), /permission denied/);
});

test('legacy order history keeps its atomic helper private from app roles', async () => {
  await assert.rejects(withRole('authenticated', customer, (tx) => tx.query("select * from create_order($1,$2,'forbidden-direct','counter','{}',$3)", [fixture.restaurant, fixture.slot, JSON.stringify([{ item_id: fixture.item, quantity: 1 }])])), /permission denied/);
  const created = await order(customer, 'test-order-1');
  const retry = await order(customer, 'test-order-1');
  assert.equal(created.id, retry.id);
  assert.equal(created.subtotal_cents, fixture.price_cents * 2);
  await assert.rejects(order(customer, 'test-order-1', { quantity: 1 }), /already used|different/);
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
  await assert.rejects(order(customer, 'test-stock-1', { quantity: 50 }), /stock|availability/);
  await database.query('update restaurants set curbside_enabled=false where id=$1', [fixture.restaurant]);
  await assert.rejects(order(customer, 'test-curbside-1', { mode: 'curbside', vehicle: { make: 'Toyota', model: 'Corolla', color: 'Blue' } }), /curbside/);
  await assert.rejects(database.query(`update pickup_slots set cutoff_at=now()-interval '1 second' where id=$1`, [fixture.slot]), /cannot reschedule/);
  const { rows: [closed] } = await database.query(`
    insert into pickup_slots (restaurant_id, starts_at, ends_at, cutoff_at, capacity)
    values ($1, now()+interval '2 seconds', now()+interval '1 hour', now()-interval '1 second', 10)
    returning id
  `, [fixture.restaurant]);
  await assert.rejects(order(customer, 'test-cutoff-1', { slot: closed.id }), /closed|cutoff/);
});

test('a curbside order completes through restaurant pickup and the customer sees the result', async () => {
  await withRole('authenticated', merchant, (tx) => tx.query('update restaurants set curbside_enabled=true where id=$1', [fixture.restaurant]));
  const created = await order(customer, 'test-curbside-full', {
    mode: 'curbside', vehicle: { make: ' Toyota ', model: 'Corolla', color: 'Blue', unrelated: 'Discarded' },
  });
  assert.deepEqual(created.vehicle, { make: 'Toyota', model: 'Corolla', color: 'Blue' });
  assert.equal(created.payment_method, 'pay_at_pickup');
  assert.ok(created.pickup_starts_at);
  await withRole('authenticated', merchant, async (tx) => {
    for (const status of ['accepted', 'preparing', 'ready', 'completed']) {
      const { rows: [updated] } = await tx.query('select * from update_order_status($1,$2)', [created.id, status]);
      assert.equal(updated.status, status);
    }
  });
  const { rows: [customerOrder] } = await withRole('authenticated', customer, (tx) => tx.query(`
    select o.status, i.prep_steps_snapshot from orders o join order_items i on i.order_id=o.id where o.id=$1
  `, [created.id]));
  assert.equal(customerOrder.status, 'completed');
  assert.ok(customerOrder.prep_steps_snapshot.length > 0);
});

test('online checkout reserves once, hides unpaid orders, and finalizes idempotently', async () => {
  const quote = await withServiceRole((tx) => tx.query(`select quote_checkout_order($1,$2,$3,$4,$5::text) as result`, [
    customer, fixture.restaurant, fixture.slot, JSON.stringify([{ item_id: fixture.item, quantity: 1 }]), null,
  ])).then(({ rows: [row] }) => row.result);
  const reserve = (tx, key) => tx.query(`select reserve_checkout_order($1,$2,$3,$4,$5,$6,$7,$8::text,$9) as result`, [
    customer, fixture.restaurant, fixture.slot, key, 'counter', '{}', JSON.stringify([{ item_id: fixture.item, quantity: 1 }]), null, quote.amount_cents,
  ]).then(({ rows: [row] }) => row.result);
  const first = await withServiceRole((tx) => reserve(tx, 'online-checkout-1'));
  const retry = await withServiceRole((tx) => reserve(tx, 'online-checkout-1'));
  assert.equal(first.order_id, retry.order_id);
  assert.equal(first.status, 'pending');
  assert.equal(first.application_fee_cents, 175);
  assert.equal(first.subtotal_cents, fixture.price_cents);
  assert.equal(first.discount_cents, 0);
  assert.equal(first.amount_cents, quote.amount_cents);
  assert.ok(first.expires_at);
  await assert.rejects(withServiceRole((tx) => reserve(tx, 'online-checkout-2')), /orders_one_pending_online_per_customer_idx|duplicate key/);

  const merchantBefore = await withRole('authenticated', merchant, (tx) => tx.query('select id from orders where id=$1', [first.order_id]));
  assert.equal(merchantBefore.rows.length, 0);
  const recorded = await withServiceRole((tx) => tx.query(`select record_checkout_session($1,$2,$3,$4,$5,$6,$7) as result`, [
    first.order_id, 'cs_fixture_1', 'https://checkout.stripe.com/c/pay/cs_fixture_1', first.stripe_account_id,
    first.amount_cents, first.application_fee_cents, first.expires_at,
  ]));
  assert.equal(recorded.rows[0].result.status, 'pending');
  const ownerCheckout = await withServiceRole((tx) => tx.query('select get_checkout_for_owner($1,$2) as checkout', [first.order_id, customer]));
  assert.deepEqual({
    order_id: ownerCheckout.rows[0].checkout.order_id,
    status: ownerCheckout.rows[0].checkout.status,
    order_status: ownerCheckout.rows[0].checkout.order_status,
    amount_cents: ownerCheckout.rows[0].checkout.amount_cents,
    subtotal_cents: ownerCheckout.rows[0].checkout.subtotal_cents,
    discount_cents: ownerCheckout.rows[0].checkout.discount_cents,
    promo_code: ownerCheckout.rows[0].checkout.promo_code,
    discount_percent: ownerCheckout.rows[0].checkout.discount_percent,
  }, {
    order_id: first.order_id, status: 'pending', order_status: 'pending_payment', amount_cents: first.amount_cents,
    subtotal_cents: first.subtotal_cents, discount_cents: 0, promo_code: null, discount_percent: null,
  });
  await assert.rejects(withRole('authenticated', customer, (tx) => tx.query(`select record_checkout_session($1,'cs_fake','https://checkout.stripe.com/fake',$2,$3,$4,$5)`, [
    first.order_id, first.stripe_account_id, first.amount_cents, first.application_fee_cents, first.expires_at,
  ])), /permission denied/);

  const finalize = (tx, eventId) => tx.query(`select finalize_checkout_event($1,'checkout.session.completed',$2,'cs_fixture_1',$3,$4,$5,'usd','paid',now()) as status`, [
    eventId, first.order_id, first.stripe_account_id, first.amount_cents, first.application_fee_cents,
  ]).then(({ rows: [row] }) => row.status);
  assert.equal(await withServiceRole((tx) => finalize(tx, 'evt_fixture_paid')), 'paid');
  assert.equal(await withServiceRole((tx) => finalize(tx, 'evt_fixture_paid')), 'paid');
  const merchantAfter = await withRole('authenticated', merchant, (tx) => tx.query('select status,payment_status from orders where id=$1', [first.order_id]));
  assert.deepEqual(merchantAfter.rows[0], { status: 'placed', payment_status: 'paid' });
  const { rows: analytics } = await database.query(`select count(*)::int as count from analytics_events where event_type='order_placed' and payload->>'order_id'=$1`, [first.order_id]);
  assert.equal(analytics[0].count, 1);
  await assert.rejects(withRole('authenticated', merchant, (tx) => tx.query("select update_order_status($1,'cancelled')", [first.order_id])), /refund/);
  await assert.rejects(withRole('authenticated',merchant,(tx)=>tx.query('delete from pickup_slots where id=(select slot_id from orders where id=$1)',[first.order_id])),/foreign key|orders/);

  await assert.rejects(withServiceRole((tx) => tx.query('select begin_checkout_refund($1,$2)', [outsider, first.order_id])), /authorized/);
  await database.query('insert into merchant_memberships(user_id,restaurant_id,role) values($1,$2,\'staff\')',
    [staff, fixture.restaurant],
  );
  await assert.rejects(withServiceRole((tx) => tx.query('select begin_checkout_refund($1,$2)', [staff, first.order_id])), /authorized/);
  const { rows: [refund] } = await withServiceRole((tx) => tx.query('select begin_checkout_refund($1,$2) as result', [merchant, first.order_id]));
  assert.equal(refund.result.status, 'pending');
  assert.equal(refund.result.amount_cents, first.amount_cents);
  const { rows: [reservedBeforeRefund] } = await database.query(`
    select s.reserved_count, i.reserved_qty
    from pickup_slots s join slot_item_inventory i on i.slot_id=s.id
    where s.id=$1 and i.item_id=$2
  `, [fixture.slot, fixture.item]);
  const { rows: [sameAttempt] } = await withServiceRole((tx) => tx.query('select begin_checkout_refund($1,$2) as result', [merchant, first.order_id]));
  assert.equal(sameAttempt.result.attempt, refund.result.attempt, 'retrying a pending refund must reuse its attempt');
  assert.equal(sameAttempt.result.refund_id, null);
  await assert.rejects(withRole('authenticated', merchant, (tx) => tx.query("select update_order_status($1,'accepted')", [first.order_id])), /refund/);
  const recordRefund = (tx) => tx.query("select record_checkout_refund($1,$2,'re_fixture','succeeded') as status", [first.order_id, refund.result.attempt]);
  await assert.rejects(withRole('authenticated', merchant, recordRefund), /permission denied/);
  await assert.rejects(withServiceRole((tx) => tx.query("select record_checkout_refund($1,$2,'bad-id','pending')", [first.order_id, refund.result.attempt])), /invalid refund result/);
  await assert.rejects(withServiceRole((tx) => tx.query("select record_checkout_refund($1,$2,'re_other','pending')", [first.order_id, refund.result.attempt + 1])), /attempt mismatch/);
  await withServiceRole((tx) => tx.query("select record_checkout_refund($1,$2,'re_pending','pending')", [first.order_id, refund.result.attempt]));
  await assert.rejects(withServiceRole((tx) => tx.query("select record_checkout_refund($1,$2,'re_other','pending')", [first.order_id, refund.result.attempt])), /refund does not match/);
  await withServiceRole((tx) => tx.query("select record_checkout_refund($1,$2,'re_pending','failed')", [first.order_id, refund.result.attempt]));
  const { rows: [retryRefund] } = await withServiceRole((tx) => tx.query('select begin_checkout_refund($1,$2) as result', [merchant, first.order_id]));
  assert.equal(retryRefund.result.status, 'pending');
  assert.equal(retryRefund.result.attempt, refund.result.attempt + 1, 'failed refund retry must get a fresh provider attempt');
  assert.equal(retryRefund.result.refund_id, null, 'failed provider ID must not be reused');
  await assert.rejects(withServiceRole((tx) => tx.query("select record_checkout_refund($1,$2,'re_other','succeeded')", [first.order_id, retryRefund.result.attempt + 1])), /attempt mismatch/);
  const recordRetry = (tx) => tx.query("select record_checkout_refund($1,$2,'re_fixture','succeeded') as status", [first.order_id, retryRefund.result.attempt]);
  assert.equal((await withServiceRole(recordRetry)).rows[0].status, 'refunded');
  assert.equal((await withServiceRole(recordRetry)).rows[0].status, 'refunded');
  const { rows: [cancelled] } = await withRole('authenticated', merchant, (tx) => tx.query('select status,payment_status from orders where id=$1', [first.order_id]));
  assert.deepEqual(cancelled, { status: 'cancelled', payment_status: 'refunded' });
  const { rows: [released] } = await database.query(`
    select s.reserved_count, i.reserved_qty
    from pickup_slots s join slot_item_inventory i on i.slot_id=s.id
    where s.id=$1 and i.item_id=$2
  `, [fixture.slot, fixture.item]);
  assert.deepEqual(released, {
    reserved_count: reservedBeforeRefund.reserved_count - 1,
    reserved_qty: reservedBeforeRefund.reserved_qty - 1,
  }, 'completed refund must release one slot and this order’s item reservation');
  const { rows: [wrongAccount] } = await withServiceRole((tx) => tx.query(
    'select checkout_refund_event_context($1,$2,$3) as result',
    [first.order_id, retryRefund.result.attempt, 'acct_wrong'],
  ));
  assert.equal(wrongAccount.result, null, 'refund webhook lookup must reject a mismatched connected account');
});

test('merchant can create pickup windows and inventory updates cannot undercut live reservations', async () => {
  const { rows: [slot] } = await withRole('authenticated', merchant, (tx) => tx.query(`
    insert into pickup_slots(restaurant_id,starts_at,ends_at,cutoff_at,capacity)
    values($1,now()+interval '6 hours',now()+interval '6 hours 30 minutes',now()+interval '5 hours 30 minutes',8)
    returning id
  `,[fixture.restaurant]));
  await withRole('authenticated',merchant,(tx)=>tx.query(`insert into slot_item_inventory(slot_id,item_id,available_qty) values($1,$2,8)`,[slot.id,fixture.item]));
  await withRole('authenticated',merchant,(tx)=>tx.query(`update slot_item_inventory set available_qty=10 where slot_id=$1 and item_id=$2`,[slot.id,fixture.item]));
  const created=await order(customer,'inventory-reservation-test',{slot:slot.id,quantity:2});
  assert.equal(created.subtotal_cents,fixture.price_cents*2);
  await assert.rejects(withRole('authenticated',merchant,(tx)=>tx.query(`update slot_item_inventory set available_qty=1 where slot_id=$1 and item_id=$2`,[slot.id,fixture.item])),/check constraint/);
  await assert.rejects(withRole('authenticated',merchant,(tx)=>tx.query(`delete from slot_item_inventory where slot_id=$1 and item_id=$2`,[slot.id,fixture.item])),/reserved/);
  await assert.rejects(withRole('authenticated',merchant,(tx)=>tx.query(`update pickup_slots set reserved_count=0 where id=$1`,[slot.id])),/permission denied/);
  await withRole('authenticated',merchant,async(tx)=>{
    for(const status of ['accepted','preparing','ready','completed']) await tx.query('select update_order_status($1,$2)',[created.id,status]);
  });
  await withRole('authenticated',merchant,(tx)=>tx.query(`delete from slot_item_inventory where slot_id=$1 and item_id=$2`,[slot.id,fixture.item]));
  await assert.rejects(withRole('authenticated',merchant,(tx)=>tx.query(`delete from pickup_slots where id=$1`,[slot.id])),/foreign key|orders/);
  const {rows:[remaining]}=await database.query('select count(*)::int as count from pickup_slots where id=$1',[slot.id]);
  assert.equal(remaining.count,1,'order history keeps its pickup slot relationship');
  const {rows:[emptySlot]}=await withRole('authenticated',merchant,(tx)=>tx.query(`
    insert into pickup_slots(restaurant_id,starts_at,ends_at,cutoff_at,capacity)
    values($1,now()+interval '8 hours',now()+interval '8 hours 30 minutes',now()+interval '7 hours 30 minutes',8)
    returning id
  `,[fixture.restaurant]));
  await withRole('authenticated',merchant,(tx)=>tx.query('insert into slot_item_inventory(slot_id,item_id,available_qty) values($1,$2,8)',[emptySlot.id,fixture.item]));
  await withRole('authenticated',merchant,(tx)=>tx.query('delete from pickup_slots where id=$1',[emptySlot.id]));
  const {rows:[cascaded]}=await database.query('select count(*)::int as count from slot_item_inventory where slot_id=$1',[emptySlot.id]);
  assert.equal(cascaded.count,0,'unbooked slot deletion cascades its inventory');
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

test('merchant catalog create and save stay atomic and private until manager review', async () => {
  await database.query('insert into auth.users(id) values($1)',[manager]);
  await database.query(`insert into merchant_memberships(user_id,restaurant_id,role) values
    ($1,$3,'staff'),($2,$3,'manager')`,[outsider,manager,fixture.restaurant]);
  const create = (tx,name) => tx.query(`select * from create_catalog_item_draft($1,$2,'Merchant draft lifecycle',1800,null,null,'{}','{}',false,$3)`,[
    fixture.restaurant,name,['Chef supplied step'],
  ]);
  const { rows: [created] } = await withRole('authenticated', outsider, (tx) => create(tx,'R07 regression kit'));
  const publicBeforeDraft = await withRole('anon', null, (tx) => tx.query(
    'select id from catalog_items where id=$1', [created.catalog_item_id],
  ));
  assert.equal(publicBeforeDraft.rows.length, 0, 'unpublished catalog row is not public');
  await assert.rejects(withRole('anon', null, (tx) => tx.query(
    'select id from prep_drafts where id=$1', [created.prep_draft_id],
  )), /permission denied/);

  const save = (tx) => tx.query(`select * from save_catalog_item_draft($1,$2,'R07 saved kit',null,1900,null,null,'{}','{}',true,$3)`,[
    created.catalog_item_id,fixture.restaurant,['Updated chef step'],
  ]);
  const {rows:[saved]}=await withRole('authenticated',outsider,save);
  await assert.rejects(withRole('authenticated',outsider,(tx)=>tx.query(
    'select * from publish_prep_draft($1,$2,$3)',[created.prep_draft_id,saved.draft_updated_at,['Reviewed final step']],
  )),/not authorized/);

  await database.exec(`
    create function public.test_reject_catalog_draft() returns trigger language plpgsql as $$
    begin if new.name='R07 rollback kit' then raise exception 'injected draft failure'; end if; return new; end $$;
    create trigger test_reject_catalog_draft before insert on public.prep_drafts
    for each row execute function public.test_reject_catalog_draft();
  `);
  try {
    await assert.rejects(withRole('authenticated',outsider,(tx)=>create(tx,'R07 rollback kit')),/injected draft failure/);
    const {rows:[rolledBack]}=await database.query(`select count(*)::int as count from catalog_items where name='R07 rollback kit'`);
    assert.equal(rolledBack.count,0,'catalog insert rolls back when draft insert fails');
  } finally {
    await database.exec('drop trigger test_reject_catalog_draft on public.prep_drafts; drop function public.test_reject_catalog_draft();');
  }

  await withRole('authenticated',manager,(tx)=>tx.query(
    'select * from publish_prep_draft($1,$2,$3)',[created.prep_draft_id,saved.draft_updated_at,['Reviewed final step']],
  ));
  const { rows: [visible] } = await withRole('anon', null, (tx) => tx.query(`
    select name,price_cents,published_steps from catalog_items where id=$1
  `, [created.catalog_item_id]));
  assert.deepEqual(visible,{name:'R07 saved kit',price_cents:1900,published_steps:['Reviewed final step']});

  const {rows:[legacy]}=await withRole('authenticated',outsider,(tx)=>tx.query(`
    insert into catalog_items(restaurant_id,name,price_cents,active)
    values($1,'R07 legacy item without draft',1200,false) returning id
  `,[fixture.restaurant]));
  const {rows:[repaired]}=await withRole('authenticated',outsider,(tx)=>tx.query(`
    select * from save_catalog_item_draft($1,$2,'R07 legacy item repaired',null,1300,null,null,'{}','{}',false,$3)
  `,[legacy.id,fixture.restaurant,['Chef instruction']]));
  assert.ok(repaired.prep_draft_id,'saving a legacy catalog row creates its missing prep draft');
  const {rows:[draft]}=await withRole('authenticated',outsider,(tx)=>tx.query(
    'select name,price_cents,source_steps from prep_drafts where id=$1',[repaired.prep_draft_id],
  ));
  assert.deepEqual(draft,{name:'R07 legacy item repaired',price_cents:1300,source_steps:['Chef instruction']});
});

test('merchant pickup window and stock creation are atomic under member RLS', async () => {
  const create=(tx,items,startsAt)=>tx.query(`
    select create_pickup_slot_with_inventory($1,$2,$3,15,25,8) as slot_id
  `,[fixture.restaurant,items,startsAt]);
  const startsAt=new Date(Date.now()+8*60*60_000).toISOString();
  const {rows:[created]}=await withRole('authenticated',merchant,(tx)=>create(tx,[fixture.item],startsAt));
  const {rows:[stock]}=await withRole('authenticated',merchant,(tx)=>tx.query(`
    select available_qty,reserved_qty from slot_item_inventory where slot_id=$1 and item_id=$2
  `,[created.slot_id,fixture.item]));
  assert.deepEqual(stock,{available_qty:8,reserved_qty:0});

  const emptyStartsAt=new Date(Date.now()+9*60*60_000).toISOString();
  const {rows:[empty]}=await withRole('authenticated',merchant,(tx)=>create(tx,[],emptyStartsAt));
  const {rows:[emptyStock]}=await database.query('select count(*)::int as count from slot_item_inventory where slot_id=$1',[empty.slot_id]);
  assert.equal(emptyStock.count,0,'empty product selection still creates a pickup window without stock rows');

  const otherItem=(await database.query('select id from catalog_items where restaurant_id<>$1 limit 1',[fixture.restaurant])).rows[0];
  assert.ok(otherItem,'seed includes a catalog item from a different restaurant');
  const failedStartsAt=new Date(Date.now()+10*60*60_000).toISOString();
  await assert.rejects(withRole('authenticated',merchant,(tx)=>create(tx,[otherItem.id],failedStartsAt)),/slot and item must belong to the same restaurant/);
  const {rows:[failedSlot]}=await database.query('select count(*)::int as count from pickup_slots where starts_at=$1',[failedStartsAt]);
  assert.equal(failedSlot.count,0,'inventory failure rolls back the just-created pickup window');

  const unauthorizedStartsAt=new Date(Date.now()+11*60*60_000).toISOString();
  await assert.rejects(withRole('authenticated',customer,(tx)=>create(tx,[],unauthorizedStartsAt)),/not authorized/);
  const {rows:[unauthorizedSlot]}=await database.query('select count(*)::int as count from pickup_slots where starts_at=$1',[unauthorizedStartsAt]);
  assert.equal(unauthorizedSlot.count,0,'nonmember cannot create a pickup window');
});
