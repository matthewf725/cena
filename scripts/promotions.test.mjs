import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const db = new PGlite({ extensions: { pgcrypto } });
const customer = '10000000-0000-4000-8000-000000000011';
const merchant = '10000000-0000-4000-8000-000000000012';
const outsider = '10000000-0000-4000-8000-000000000013';
const staff = '10000000-0000-4000-8000-000000000014';
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
  await db.query('insert into auth.users(id) values($1),($2),($3),($4)', [customer,merchant,outsider,staff]);
  const { rows: [row] } = await db.query(`
    select r.id as restaurant,s.id as slot,c.id as item,c.price_cents
    from restaurants r join pickup_slots s on s.restaurant_id=r.id
    join slot_item_inventory i on i.slot_id=s.id join catalog_items c on c.id=i.item_id
    where r.active and s.active and s.starts_at>now()+interval '40 minutes' and s.cutoff_at>now() order by s.starts_at limit 1
  `);
  assert.ok(row);
  fixture = row;
  await db.query('update catalog_items set price_cents=2000 where id=$1',[row.item]);
  fixture.price_cents=2000;
  await db.query("insert into merchant_memberships(user_id,restaurant_id,role) values($1,$2,'owner')", [merchant,row.restaurant]);
  await db.query(`insert into restaurant_payment_accounts(restaurant_id,stripe_account_id,application_fee_cents,charges_enabled,payouts_enabled)
    values($1,'acct_promofixture',175,true,true)`, [row.restaurant]);
});

after(async () => db.close());

async function as(role,user,fn) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user??'']);
    return fn(tx);
  });
}
async function service(fn) {
  return db.transaction(async (tx) => { await tx.exec('set local role service_role'); return fn(tx); });
}
function save(tx, startsAt, endsAt, active=true) {
  return tx.query(`select save_restaurant_promotion($1,'sunday25',25,$2,$3,1,$4) as result`,
    [fixture.restaurant,startsAt,endsAt,active]).then(({rows:[r]})=>r.result);
}
function quote(tx, who=customer, code='sUnDaY25') {
  return tx.query(`select quote_checkout_order($1,$2,$3,$4,$5::text) as result`, [
    who,fixture.restaurant,fixture.slot,JSON.stringify([{item_id:fixture.item,quantity:1}]),code,
  ]).then(({rows:[r]})=>r.result);
}
function reserve(tx,key,expected,code='sUnDaY25') {
  return tx.query(`select reserve_checkout_order($1,$2,$3,$4,'counter','{}',$5,$6::text,$7) as result`, [
    customer,fixture.restaurant,fixture.slot,key,JSON.stringify([{item_id:fixture.item,quantity:1}]),code,expected,
  ]).then(({rows:[r]})=>r.result);
}

test('restaurant promotions are private, scheduled, scoped, capped, and snapshotted through checkout', async () => {
  const futureStart = new Date(Date.now()+60*60*1000).toISOString();
  const futureEnd = new Date(Date.now()+2*60*60*1000).toISOString();
  const saved = await as('authenticated',merchant,(tx)=>save(tx,futureStart,futureEnd));
  assert.equal(saved.code,'SUNDAY25');
  assert.equal(saved.redemption_count,0);
  await assert.rejects(as('authenticated',outsider,(tx)=>tx.query('select list_restaurant_promotions($1)',[fixture.restaurant])),/not authorized/);
  await assert.rejects(as('authenticated',customer,(tx)=>tx.query('select * from restaurant_promotions')),/permission denied/);
  await assert.rejects(service((tx)=>quote(tx)),/unavailable/);

  const activeStart = new Date(Date.now()-60*1000).toISOString();
  const updated = await as('authenticated',merchant,(tx)=>save(tx,activeStart,futureEnd));
  const quoted = await service((tx)=>quote(tx));
  const expectedDiscount = Math.floor((fixture.price_cents*25+50)/100);
  assert.equal(expectedDiscount,500,'a 25% code discounts $20.00 by $5.00');
  assert.deepEqual({code:quoted.promo_code,percent:quoted.discount_percent,subtotal:quoted.subtotal_cents,discount:quoted.discount_cents,total:quoted.amount_cents}, {
    code:'SUNDAY25',percent:25,subtotal:fixture.price_cents,discount:expectedDiscount,total:fixture.price_cents-expectedDiscount,
  });
  await assert.rejects(service((tx)=>tx.query(`select reserve_checkout_order($1,$2,$3,$4,'counter','{}',$5,$6::text,$7)`, [
    customer,fixture.restaurant,fixture.slot,'promo-stale-quote',JSON.stringify([{item_id:fixture.item,quantity:1}]),'sunday25',quoted.amount_cents+1,
  ])),/quote changed/);

  const first = await service((tx)=>reserve(tx,'promo-order-0001',quoted.amount_cents));
  const retry = await service((tx)=>reserve(tx,'promo-order-0001',quoted.amount_cents));
  assert.equal(first.order_id,retry.order_id);
  assert.equal(first.amount_cents,quoted.amount_cents);
  assert.equal(first.discount_cents,expectedDiscount);
  const {rows:[held]}=await db.query('select reserved_redemptions,redeemed_count from restaurant_promotions where code=$1',['SUNDAY25']);
  assert.deepEqual(held,{reserved_redemptions:1,redeemed_count:0});
  const changedWhilePending=await as('authenticated',merchant,(tx)=>tx.query(`
    select save_restaurant_promotion($1,'SUNDAY25',30,$2,$3,1,true) as result
  `,[fixture.restaurant,activeStart,futureEnd]));
  assert.equal(changedWhilePending.rows[0].result.discount_percent,30);
  const {rows:[pendingSnapshot]}=await db.query('select discount_percent,discount_cents,total_cents from orders where id=$1',[first.order_id]);
  assert.deepEqual(pendingSnapshot,{discount_percent:25,discount_cents:expectedDiscount,total_cents:quoted.amount_cents});
  await assert.rejects(service((tx)=>quote(tx,outsider)),/unavailable/);

  await service((tx)=>tx.query(`select record_checkout_session($1,'cs_promo_cancel','https://checkout.stripe.com/c/pay/cs_promo_cancel',$2,$3,$4,$5)`,[
    first.order_id,first.stripe_account_id,first.amount_cents,first.application_fee_cents,first.expires_at,
  ]));
  const pendingOwner=await service((tx)=>tx.query('select get_checkout_for_owner($1,$2) as checkout',[first.order_id,customer]));
  assert.deepEqual(Object.fromEntries(['order_id','status','order_status','session_id','stripe_account_id','amount_cents','subtotal_cents','discount_cents','promo_code','discount_percent','application_fee_cents','currency'].map((key)=>[key,pendingOwner.rows[0].checkout[key]])),{
    order_id:first.order_id,status:'pending',order_status:'pending_payment',session_id:'cs_promo_cancel',stripe_account_id:first.stripe_account_id,
    amount_cents:quoted.amount_cents,subtotal_cents:fixture.price_cents,discount_cents:expectedDiscount,promo_code:'SUNDAY25',
    discount_percent:25,application_fee_cents:first.application_fee_cents,currency:'usd',
  });
  await assert.rejects(service((tx)=>tx.query('select get_checkout_for_owner($1,$2)',[first.order_id,outsider])),/order not found/);
  await assert.rejects(as('authenticated',customer,(tx)=>tx.query('select get_checkout_for_owner($1,$2)',[first.order_id,customer])),/permission denied/);
  const pendingCustomerOrder=await as('authenticated',customer,(tx)=>tx.query('select payment_status from orders where id=$1',[first.order_id]));
  const hiddenPendingForMerchant=await as('authenticated',merchant,(tx)=>tx.query('select id from orders where id=$1',[first.order_id]));
  assert.deepEqual(pendingCustomerOrder.rows,[{payment_status:'pending'}]);
  assert.equal(hiddenPendingForMerchant.rows.length,0,'pending checkout stays hidden from merchant RLS');
  await service((tx)=>tx.query('select cancel_checkout_if_unpaid($1,$2,$3)',[first.order_id,'cs_promo_cancel',first.stripe_account_id]));
  const {rows:[released]}=await db.query('select reserved_redemptions from restaurant_promotions where code=$1',['SUNDAY25']);
  assert.equal(released.reserved_redemptions,0);

  const refreshedQuote=await service((tx)=>quote(tx));
  assert.equal(refreshedQuote.discount_percent,30);
  const second=await service((tx)=>reserve(tx,'promo-order-0002',refreshedQuote.amount_cents));
  await service((tx)=>tx.query(`select record_checkout_session($1,'cs_promo_paid','https://checkout.stripe.com/c/pay/cs_promo_paid',$2,$3,$4,$5)`,[
    second.order_id,second.stripe_account_id,second.amount_cents,second.application_fee_cents,second.expires_at,
  ]));
  await service((tx)=>tx.query(`select finalize_checkout_event('evt_promo_paid','checkout.session.completed',$1,'cs_promo_paid',$2,$3,$4,'usd','paid',now())`,[
    second.order_id,second.stripe_account_id,second.amount_cents,second.application_fee_cents,
  ]));
  const paidOwner=await service((tx)=>tx.query('select get_checkout_for_owner($1,$2) as checkout',[second.order_id,customer]));
  assert.deepEqual(Object.fromEntries(['order_id','status','order_status','session_id','stripe_account_id','amount_cents','subtotal_cents','discount_cents','promo_code','discount_percent','application_fee_cents','currency'].map((key)=>[key,paidOwner.rows[0].checkout[key]])),{
    order_id:second.order_id,status:'paid',order_status:'placed',session_id:'cs_promo_paid',stripe_account_id:second.stripe_account_id,
    amount_cents:refreshedQuote.amount_cents,subtotal_cents:fixture.price_cents,discount_cents:refreshedQuote.discount_cents,promo_code:'SUNDAY25',
    discount_percent:30,application_fee_cents:second.application_fee_cents,currency:'usd',
  });
  const visiblePaidForMerchant=await as('authenticated',merchant,(tx)=>tx.query('select payment_status from orders where id=$1',[second.order_id]));
  assert.deepEqual(visiblePaidForMerchant.rows,[{payment_status:'paid'}],'settled checkout becomes visible through merchant RLS');
  await db.query("insert into merchant_memberships(user_id,restaurant_id,role) values($1,$2,'staff')",[staff,fixture.restaurant]);
  await assert.rejects(service((tx)=>tx.query('select begin_checkout_refund($1,$2)',[outsider,second.order_id])),/not authorized/);
  await assert.rejects(service((tx)=>tx.query('select begin_checkout_refund($1,$2)',[staff,second.order_id])),/not authorized/);
  await assert.rejects(as('authenticated',merchant,(tx)=>tx.query('select begin_checkout_refund($1,$2)',[merchant,second.order_id])),/permission denied/);
  const refund=await service((tx)=>tx.query('select begin_checkout_refund($1,$2) as result',[merchant,second.order_id]));
  assert.deepEqual(Object.fromEntries(['status','order_id','attempt','refund_id','session_id','stripe_account_id','amount_cents','subtotal_cents','discount_cents','promo_code','discount_percent','currency','application_fee_cents'].map((key)=>[key,refund.rows[0].result[key]])),{
    status:'pending',order_id:second.order_id,attempt:1,refund_id:null,session_id:'cs_promo_paid',stripe_account_id:second.stripe_account_id,
    amount_cents:refreshedQuote.amount_cents,subtotal_cents:fixture.price_cents,discount_cents:refreshedQuote.discount_cents,
    promo_code:'SUNDAY25',discount_percent:30,currency:'usd',application_fee_cents:second.application_fee_cents,
  });
  const refundEvent=await service((tx)=>tx.query('select checkout_refund_event_context($1,$2,$3) as result',[second.order_id,refund.rows[0].result.attempt,second.stripe_account_id]));
  assert.deepEqual(Object.fromEntries(['order_id','amount_cents','currency','subtotal_cents','discount_cents','promo_code','discount_percent','application_fee_cents','stripe_account_id','session_id','refund_id'].map((key)=>[key,refundEvent.rows[0].result[key]])),{
    order_id:second.order_id,amount_cents:refreshedQuote.amount_cents,currency:'usd',subtotal_cents:fixture.price_cents,
    discount_cents:refreshedQuote.discount_cents,promo_code:'SUNDAY25',discount_percent:30,application_fee_cents:second.application_fee_cents,
    stripe_account_id:second.stripe_account_id,session_id:'cs_promo_paid',refund_id:null,
  });
  const wrongRefundAccount=await service((tx)=>tx.query('select checkout_refund_event_context($1,$2,$3) as result',[second.order_id,refund.rows[0].result.attempt,'acct_wrong']));
  assert.equal(wrongRefundAccount.rows[0].result,null,'refund event context remains scoped to the recorded connected account');
  const {rows:[used]}=await db.query('select reserved_redemptions,redeemed_count from restaurant_promotions where code=$1',['SUNDAY25']);
  assert.deepEqual(used,{reserved_redemptions:0,redeemed_count:1});
  const {rows:[order]}=await db.query('select subtotal_cents,discount_cents,total_cents,promo_code_snapshot,discount_percent from orders where id=$1',[second.order_id]);
  assert.deepEqual(order,{subtotal_cents:fixture.price_cents,discount_cents:refreshedQuote.discount_cents,total_cents:refreshedQuote.amount_cents,promo_code_snapshot:'SUNDAY25',discount_percent:30});
  const listed=await as('authenticated',merchant,(tx)=>tx.query('select list_restaurant_promotions($1) as promos',[fixture.restaurant]));
  assert.equal(listed.rows[0].promos[0].redemption_count,1);
});

test('checkout quote rejects slots inside the reservation cutoff', async () => {
  const nearStart = new Date(Date.now()+20*60*1000).toISOString();
  const { rows: [slot] } = await db.query(`insert into pickup_slots(restaurant_id,starts_at,ends_at,cutoff_at,capacity)
    values($1,$2::timestamptz,$2::timestamptz+interval '30 minutes',$2::timestamptz-interval '15 minutes',12) returning id`,
    [fixture.restaurant,nearStart]);
  try {
    await service((tx)=>tx.query(`select quote_checkout_order($1,$2,$3,$4,$5::text)`,[
      customer,fixture.restaurant,slot.id,JSON.stringify([{item_id:fixture.item,quantity:1}]),'sunday25',
    ]));
    assert.fail('near-term slot was quoteable');
  } catch (error) {
    assert.match(String(error),/pickup slot closed/);
  } finally {
    await db.query('delete from pickup_slots where id=$1',[slot.id]);
  }
});

test('reservation release locks pickup slot before UUID-ordered inventory like create_order', async () => {
  const initial = await readFile(new URL('../supabase/migrations/20261114000000_initial.sql',import.meta.url),'utf8');
  const checkout = await readFile(new URL('../supabase/migrations/20261114000008_checkout_cutoff_and_lock_order.sql',import.meta.url),'utf8');
  const createOrder = initial.slice(initial.indexOf('create or replace function public.create_order('),initial.indexOf('create or replace function public.update_order_status('));
  const release = checkout.slice(checkout.indexOf('create or replace function public.release_checkout_reservation('));
  const createSlot = createOrder.indexOf('where id=p_slot_id and restaurant_id=p_restaurant_id for update');
  const createInventory = createOrder.indexOf('from public.slot_item_inventory where slot_id=p_slot_id and item_id=v_item.id for update');
  const releaseSlot = release.indexOf('perform 1 from public.pickup_slots where id=o.slot_id for update');
  const releaseInventory = release.indexOf('perform 1 from public.slot_item_inventory where slot_id=o.slot_id and item_id=v_item for update');
  assert.ok(createSlot >= 0 && createInventory > createSlot,'create_order locks slot before inventory');
  assert.ok(releaseSlot >= 0 && releaseInventory > releaseSlot,'release locks slot before inventory');
  assert.match(release,/where i\.slot_id=o\.slot_id order by i\.item_id/,'release inventory locks are UUID ordered');
});
