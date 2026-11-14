import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const db = new PGlite({ extensions: { pgcrypto } });
const customer = '10000000-0000-4000-8000-000000000051';
const merchant = '10000000-0000-4000-8000-000000000052';
let fixture;

before(async () => {
  await db.exec(`
    create schema extensions; create schema auth;
    create role anon; create role authenticated; create role service_role bypassrls;
    create table auth.users (id uuid primary key,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    grant usage on schema auth to anon,authenticated,service_role;
  `);
  const dir = new URL('../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter((x) => x.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, dir), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/seed.sql', import.meta.url), 'utf8'));
  await db.query('insert into auth.users(id) values($1),($2)', [customer, merchant]);
  const { rows: [row] } = await db.query(`
    select r.id as restaurant,s.id as slot,c.id as item,c.price_cents
    from restaurants r join pickup_slots s on s.restaurant_id=r.id
    join slot_item_inventory i on i.slot_id=s.id join catalog_items c on c.id=i.item_id
    where r.active and s.active and s.starts_at>now()+interval '40 minutes' and s.cutoff_at>now()
    order by s.starts_at limit 1
  `);
  assert.ok(row);
  fixture = row;
  await db.query("insert into merchant_memberships(user_id,restaurant_id,role) values($1,$2,'owner')", [merchant,row.restaurant]);
  await db.query(`insert into restaurant_payment_accounts(restaurant_id,stripe_account_id,application_fee_cents,charges_enabled,payouts_enabled)
    values($1,'acct_reconcilefixture',175,true,true) on conflict(restaurant_id) do update set stripe_account_id='acct_reconcilefixture',
    application_fee_cents=175,charges_enabled=true,payouts_enabled=true`, [row.restaurant]);
});

after(async () => db.close());

async function service(fn) {
  return db.transaction(async (tx) => { await tx.exec('set local role service_role'); return fn(tx); });
}

test('recorded checkout claims are exclusive, stale leases cannot finish, and uncertain states retain inventory', async () => {
  const { rows: [quoted] } = await service((tx) => tx.query(`select quote_checkout_order($1,$2,$3,$4,null) as result`, [
    customer, fixture.restaurant, fixture.slot, JSON.stringify([{item_id:fixture.item,quantity:1}]),
  ]));
  const { rows: [reserved] } = await service((tx) => tx.query(`select reserve_checkout_order($1,$2,$3,$4,'counter','{}',$5,null,$6) as result`, [
    customer, fixture.restaurant, fixture.slot, 'reconcile-order-0001', JSON.stringify([{item_id:fixture.item,quantity:1}]), quoted.result.amount_cents,
  ]));
  await service((tx) => tx.query(`select record_checkout_session($1,'cs_reconcile1','https://checkout.stripe.com/c/pay/cs_reconcile1',$2,$3,$4,$5)`, [
    reserved.result.order_id, reserved.result.stripe_account_id, reserved.result.amount_cents, reserved.result.application_fee_cents, reserved.result.expires_at,
  ]));
  await db.query(`update order_checkout_sessions set expires_at=now()-interval '1 minute',reconcile_after=now()-interval '1 minute' where order_id=$1`, [reserved.result.order_id]);

  const claim = async () => service((tx) => tx.query(`select coalesce(jsonb_agg(x),'[]'::jsonb) as claims
    from claim_due_checkout_reconciliations(5,300) as t(x)`));
  const { rows: [first] } = await claim();
  assert.equal(first.claims.length, 1);
  assert.equal(first.claims[0].session_id, 'cs_reconcile1');
  const { rows: [empty] } = await claim();
  assert.deepEqual(empty.claims, [], 'a second worker cannot claim the live lease');

  await db.query('update order_checkout_sessions set reconcile_claimed_until=now()-interval \'1 second\' where order_id=$1', [reserved.result.order_id]);
  const competingWorkers = await Promise.all([claim(), claim()]);
  const secondClaims = competingWorkers.flatMap(({rows:[row]}) => row.claims);
  assert.equal(secondClaims.length, 1, 'simultaneous workers produce one lease owner');
  assert.notEqual(secondClaims[0].claim_id, first.claims[0].claim_id);
  const { rows: [stale] } = await service((tx) => tx.query('select finish_checkout_reconciliation($1,$2,true) as ok', [reserved.result.order_id, first.claims[0].claim_id]));
  assert.equal(stale.ok, false, 'stale worker cannot defer or finish a newer claim');

  const { rows: [deferred] } = await service((tx) => tx.query('select finish_checkout_reconciliation($1,$2,true) as ok', [reserved.result.order_id, secondClaims[0].claim_id]));
  assert.equal(deferred.ok, true);
  const { rows: [stillPending] } = await db.query(`
    select o.payment_status,o.status,s.reconcile_attempts,s.reconcile_after>now() as backoff,
      i.reserved_qty,ps.reserved_count
    from orders o join order_checkout_sessions s on s.order_id=o.id
    join order_items oi on oi.order_id=o.id join slot_item_inventory i on i.slot_id=o.slot_id and i.item_id=oi.item_id
    join pickup_slots ps on ps.id=o.slot_id where o.id=$1
  `, [reserved.result.order_id]);
  assert.equal(stillPending.payment_status, 'pending');
  assert.equal(stillPending.status, 'pending_payment');
  assert.equal(stillPending.reconcile_attempts, 1);
  assert.equal(stillPending.backoff, true);
  assert.equal(stillPending.reserved_qty, 1, 'uncertain provider state keeps item inventory reserved');
  assert.equal(stillPending.reserved_count, 1, 'uncertain provider state keeps slot inventory reserved');

  await db.query('update order_checkout_sessions set reconcile_after=now()-interval \'1 second\' where order_id=$1', [reserved.result.order_id]);
  const { rows: [third] } = await claim();
  assert.equal(third.claims.length, 1);
  const { rows: [released] } = await service((tx) => tx.query(`select release_expired_checkout($1,$2,$3,'expired') as result`, [
    reserved.result.order_id, 'cs_reconcile1', reserved.result.stripe_account_id,
  ]));
  assert.equal(released.result, 'expired');
  const { rows: [finished] } = await service((tx) => tx.query('select finish_checkout_reconciliation($1,$2,false) as ok', [reserved.result.order_id, third.claims[0].claim_id]));
  assert.equal(finished.ok, true);
  const { rows: [terminal] } = await db.query('select payment_status,status from orders where id=$1', [reserved.result.order_id]);
  assert.deepEqual(terminal, {payment_status:'expired',status:'cancelled'});
  const { rows: [none] } = await claim();
  assert.deepEqual(none.claims, [], 'terminal sessions leave the reconciliation queue');
});
