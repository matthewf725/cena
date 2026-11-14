import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium, webkit } from 'playwright';

const browserTypes = { chromium, webkit };
const customerOrigin = process.env.CENA_E2E_CUSTOMER_ORIGIN || 'http://localhost:8081';
const restaurantOrigin = process.env.CENA_E2E_RESTAURANT_ORIGIN || 'http://localhost:8082';
const mailpitOrigin = 'http://127.0.0.1:54324';
const restaurantSlug = 'sunrise-cafe';
const mealName = 'Rigatoni alla Vodka Kit';

export async function runBrowserFlow({ browserName, supabase, serviceRoleKey, apiOrigin, fake, runId, artifactsDir }) {
  const type = browserTypes[browserName];
  if (!type) throw new Error(`Unsupported browser ${browserName}`);
  const browser = await type.launch({ headless: process.env.CENA_E2E_HEADLESS !== '0' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const errors = [];
  const networkBlocks = [];
  const apiTrace = [];
  const externalPages = [];
  let routesInstalled = false;
  context.on('response', response => {
    try {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/v1/')) apiTrace.push(`${response.request().method()} ${url.host}${url.pathname} -> ${response.status()}`);
    } catch { /* non-http response */ }
  });
  context.on('requestfailed', request => {
    try {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/v1/')) apiTrace.push(`${request.method()} ${url.host}${url.pathname} failed: ${request.failure()?.errorText || 'network error'}`);
    } catch { /* non-http request */ }
  });
  let orderId = null;
  let customerToken = null;
  let customerUserId = null;
  let merchantToken = null;
  let fixtureRestaurantId = null;
  let promoCode = `QA${runId.slice(-10)}${browserName === 'webkit' ? 'W' : 'C'}`.toUpperCase();
  let customerPage;
  let merchantPage;
  const report = { browser: browserName, runId, promoCode, stages: [] };

  const serviceHeaders = {
    apikey: serviceRoleKey,
    authorization: serviceRoleKey.startsWith('sb_secret_') ? undefined : `Bearer ${serviceRoleKey}`,
    'content-type': 'application/json',
  };
  for (const [key, value] of Object.entries(serviceHeaders)) if (value === undefined) delete serviceHeaders[key];

  async function serviceRequest(path, init = {}) {
    const response = await fetch(`${supabase.apiUrl}${path}`, {
      ...init,
      headers: { ...serviceHeaders, ...(init.headers || {}) },
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(`Local Supabase request failed (${response.status}) at ${path}`);
    return body;
  }

  async function createMerchantFixture() {
    const email = `cena-e2e-${runId}-${browserName}@cena.test`;
    const password = `Qa-${randomBytes(16).toString('base64url')}-9!`;
    const create = await serviceRequest('/auth/v1/admin/users', {
      method: 'POST', body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: 'Cena QA Owner' } }),
    });
    const restaurants = await serviceRequest(`/rest/v1/restaurants?select=id,name,slug&slug=eq.${restaurantSlug}&active=eq.true&limit=1`);
    assert.equal(restaurants.length, 1, `Seed restaurant ${restaurantSlug} must exist locally`);
    const source = restaurants[0];
    const sourceItems = await serviceRequest(`/rest/v1/catalog_items?select=*&restaurant_id=eq.${source.id}&name=eq.${encodeURIComponent(mealName)}&active=eq.true&limit=1`);
    assert.equal(sourceItems.length, 1, `Seed menu item ${mealName} must exist locally`);
    const sourceSlots = await serviceRequest(`/rest/v1/pickup_slots?select=*&restaurant_id=eq.${source.id}&active=eq.true&cutoff_at=gt.${encodeURIComponent(new Date().toISOString())}&order=starts_at.asc&limit=1`);
    assert.ok(sourceSlots.length, `Seed restaurant ${source.slug} needs a future pickup slot`);
    const restaurantRows = await serviceRequest('/rest/v1/restaurants?select=id,name,slug', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ slug: `cena-e2e-${runId}-${browserName}`, name: `QA Sunrise ${runId.slice(-6)} ${browserName}`, description: 'Disposable local browser QA restaurant.', cuisine: 'Cafe', image_key: 'sunrise-cafe-cover', timezone: 'America/Los_Angeles', address: 'Local QA only', curbside_enabled: true, active: true }),
    });
    const restaurant = restaurantRows[0];
    const sourceItem = sourceItems[0];
    const itemRows = await serviceRequest('/rest/v1/catalog_items?select=id', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ restaurant_id: restaurant.id, name: sourceItem.name, description: sourceItem.description, price_cents: sourceItem.price_cents, regular_price_cents: sourceItem.regular_price_cents, equipment: sourceItem.equipment, allergens: sourceItem.allergens, published_steps: sourceItem.published_steps, image_key: sourceItem.image_key, image_url: sourceItem.image_url, category: sourceItem.category, active: true, prep_minutes: sourceItem.prep_minutes, published_at: new Date().toISOString() }),
    });
    const itemId = itemRows[0].id;
    const sourceSlot = sourceSlots[0];
    const slotRows = await serviceRequest('/rest/v1/pickup_slots?select=id', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ restaurant_id: restaurant.id, starts_at: sourceSlot.starts_at, ends_at: sourceSlot.ends_at, cutoff_at: sourceSlot.cutoff_at, capacity: sourceSlot.capacity, active: true }),
    });
    await serviceRequest('/rest/v1/slot_item_inventory', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ slot_id: slotRows[0].id, item_id: itemId, available_qty: sourceSlot.capacity, reserved_qty: 0 }),
    });
    await serviceRequest('/rest/v1/merchant_memberships', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: create.id, restaurant_id: restaurant.id, role: 'owner' }),
    });
    return { email, password, restaurant };
  }

  async function createRoutes(page) {
    page.on('pageerror', error => errors.push(error.message));
    if (routesInstalled) return;
    routesInstalled = true;
    await context.route('**/*', async route => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.hostname === 'checkout.stripe.com') {
        const sessionId = requestUrl.pathname.split('/').filter(Boolean).at(-1);
        const current = context.pages().find(candidate => candidate.url().includes('checkout.stripe.com')) || page;
        externalPages.push(current);
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><meta name="viewport" content="width=device-width"><main><h1>Fake Stripe Checkout</h1><p>Local QA only. No card details are collected.</p><button id="pay">Pay with fake test card</button><p id="result" aria-live="polite"></p></main><script>document.querySelector('#pay').addEventListener('click',async()=>{const b=document.querySelector('#pay');b.disabled=true;const r=await fetch('${fake.origin}/__qa/pay/${sessionId}',{method:'POST'});const v=await r.json();document.querySelector('#result').textContent=v.paid?'Fake payment confirmed':'Fake payment was not confirmed';if(v.paid)setTimeout(()=>{if(window.opener){window.opener.location.href='${customerOrigin}';window.close()}else location.href='${customerOrigin}'},250);});</script>`,
        });
        return;
      }
      if (requestUrl.hostname === 'connect.stripe.com') {
        const current = context.pages().find(candidate => candidate.url().includes('connect.stripe.com')) || page;
        externalPages.push(current);
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><meta name="viewport" content="width=device-width"><h1>Fake Stripe Connect</h1><p>Local QA onboarding; no external Stripe account is created.</p><button onclick="location.href='${restaurantOrigin}'">Return to restaurant</button>`,
        });
        return;
      }

      if (requestUrl.pathname.startsWith('/v1/') && ['localhost', '127.0.0.1', '::1'].includes(requestUrl.hostname)) {
        const expectedApi = new URL(apiOrigin);
        const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, expectedApi);
        try {
          const upstream = await route.fetch({ url: target.toString(), maxRedirects: 0, timeout: 10000 });
          await route.fulfill({ response: upstream });
        } catch (error) {
          networkBlocks.push(`Local API proxy failed for ${requestUrl.pathname}: ${error instanceof Error ? error.message : String(error)}`);
          await route.abort('failed').catch(() => {});
        }
        return;
      }

      if (['http:', 'https:'].includes(requestUrl.protocol) && !['localhost', '127.0.0.1', '::1'].includes(requestUrl.hostname)) {
        networkBlocks.push(`${requestUrl.protocol}//${requestUrl.hostname}`);
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
  }

  async function readOtp(email) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await fetch(`${mailpitOrigin}/api/v1/messages`);
      if (response.ok) {
        const inbox = await response.json();
        const message = (inbox.messages || []).find(item => item.To?.some(to => to.Address?.toLowerCase() === email.toLowerCase()));
        if (message) {
          const detailResponse = await fetch(`${mailpitOrigin}/api/v1/message/${message.ID}`);
          if (detailResponse.ok) {
            const detail = await detailResponse.json();
            const source = `${detail.Text || ''}\n${detail.HTML || ''}`;
            const codes = source.match(/\b\d{6}\b/g) || [];
            if (codes.length) return codes.at(-1);
          }
        }
      }
      await delay(500);
    }
    throw new Error(`Mailpit did not receive the local sign-in code for ${email}`);
  }

  async function clickGotIt(page) {
    const gotIt = page.getByRole('button', { name: 'Got it', exact: true });
    if (await gotIt.count()) await gotIt.click();
  }

  async function sendAndVerifyAccountOtp(page, email, codeInput, verifyButton) {
    await page.getByPlaceholder('Add an email address').fill(email);
    await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
    const code = await readOtp(email);
    await page.getByPlaceholder(codeInput).fill(code);
    await page.getByRole('button', { name: verifyButton, exact: true }).click();
  }

  async function queryRows(table, select, filters) {
    const params = new URLSearchParams({ select, ...filters });
    return serviceRequest(`/rest/v1/${table}?${params}`);
  }

  async function queryOrder(id) {
    const rows = await queryRows('orders', 'id,status,payment_status,subtotal_cents,discount_cents,total_cents,promo_code_snapshot,application_fee_cents', { id: `eq.${id}` });
    assert.equal(rows.length, 1, `Synthetic order ${id} should exist in local Supabase`);
    return rows[0];
  }

  async function queryPromo(restaurantId) {
    const rows = await queryRows('restaurant_promotions', 'id,code,discount_percent,max_redemptions,reserved_redemptions,redeemed_count,active', {
      restaurant_id: `eq.${restaurantId}`, code: `eq.${promoCode}`,
    });
    assert.equal(rows.length, 1, `Synthetic promotion ${promoCode} should exist`);
    return rows[0];
  }

  async function reloadRestaurantData() {
    const refresh = merchantPage.getByRole('button', { name: 'Refresh restaurant data', exact: true });
    await refresh.click();
    await merchantPage.getByText('Payments & payouts', { exact: true }).waitFor();
  }

  async function startPickupFlow(page) {
    const bagTab = page.getByRole('tab', { name: /Bag, 2 items/ });
    await bagTab.waitFor();
    await bagTab.click();
    await page.getByText('Continue to pickup', { exact: true }).click();
    await page.getByText('Choose pickup time', { exact: true }).click();
    await page.getByText('Continue to details', { exact: true }).click();
  }

  async function getLocalAppPage(port, fallback, origin) {
    let candidate = context.pages().find(item => {
      try { return new URL(item.url()).port === String(port); } catch { return false; }
    }) || fallback;
    try {
      if (new URL(candidate.url()).port !== String(port)) await candidate.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {
      await candidate.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    return candidate;
  }

  try {
    const fixture = await createMerchantFixture();
    fixtureRestaurantId = fixture.restaurant.id;
    report.restaurant = fixture.restaurant.name;
    report.stages.push('local synthetic merchant fixture provisioned');

    merchantPage = await context.newPage();
    await createRoutes(merchantPage);
    const authResponses = [];
    merchantPage.on('response', response => {
      if (response.url().includes('/auth/v1/token') && response.request().method() === 'POST') authResponses.push(response);
    });
    await merchantPage.goto(restaurantOrigin, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await merchantPage.getByPlaceholder('Email', { exact: true }).fill(fixture.email);
    await merchantPage.getByPlaceholder('Password', { exact: true }).fill(fixture.password);
    await merchantPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await merchantPage.getByText('Manage', { exact: true }).waitFor({ timeout: 30000 });
    const successfulAuth = authResponses.find(response => response.ok());
    merchantToken = successfulAuth ? (await successfulAuth.json()).access_token : await merchantPage.evaluate(() => {
      for (let index = 0; index < localStorage.length; index += 1) {
        try {
          const value = JSON.parse(localStorage.getItem(localStorage.key(index)) || 'null');
          if (value?.access_token) return value.access_token;
        } catch { /* unrelated local storage entry */ }
      }
      return null;
    });
    assert.ok(merchantToken, 'Disposable local restaurant owner should have a stored Supabase session');
    const browserApiProbe = await merchantPage.evaluate(async ({ origin, token, restaurantId }) => {
      const result = {};
      try { result.health = await fetch(`${origin}/healthz`).then(response => response.status); }
      catch (error) { result.healthError = error instanceof Error ? error.message : String(error); }
      try {
        const response = await fetch(`${origin}/v1/restaurants/${restaurantId}/payments`, { headers: { Authorization: `Bearer ${token}` } });
        result.paymentStatus = response.status;
        result.paymentBody = await response.text();
      } catch (error) { result.paymentError = error instanceof Error ? error.message : String(error); }
      return result;
    }, { origin: apiOrigin, token: merchantToken, restaurantId: fixture.restaurant.id });
    console.log(`Browser Go API probe: ${JSON.stringify(browserApiProbe)}`);
    report.stages.push('restaurant owner signed in');
    await merchantPage.getByText('Manage', { exact: true }).click();
    await merchantPage.getByText('Payments & payouts', { exact: true }).scrollIntoViewIfNeeded();
    report.stages.push('restaurant Manage screen opened');

    const readyText = merchantPage.getByText('Stripe connected · ready for online orders', { exact: true });
    if (!(await readyText.count())) {
      const connect = merchantPage.getByRole('button', { name: 'Connect Stripe', exact: true });
      await connect.scrollIntoViewIfNeeded();
      await connect.click();
      const externalConnect = await waitForExternalPage(context, 'connect.stripe.com', 12000);
      if (externalConnect) {
        await externalConnect.getByRole('button', { name: 'Return to restaurant', exact: true }).click().catch(() => {});
      }
      await reloadRestaurantData();
    }
    await readyText.waitFor({ timeout: 30000 });
    await merchantPage.getByText(/Cena fee: \$1\.75 per paid order\./).waitFor({ timeout: 15000 });
    report.stages.push('merchant payment readiness displayed with $1.75 fee');

    await merchantPage.getByText('Promo codes', { exact: true }).scrollIntoViewIfNeeded();
    await merchantPage.getByRole('button', { name: '+ Add code', exact: true }).click();
    await merchantPage.getByLabel('CODE (3–32 CHARACTERS)').fill(promoCode);
    await merchantPage.getByLabel('DISCOUNT PERCENT (1–90)').fill('10');
    await merchantPage.getByLabel('MAX REDEMPTIONS (OPTIONAL)').fill('1');
    const savePromo = merchantPage.getByText('Save promo code', { exact: true });
    await savePromo.click();
    await merchantPage.getByText('Promo code saved', { exact: true }).waitFor({ timeout: 15000 });
    let promo = await queryPromo(fixture.restaurant.id);
    assert.equal(promo.discount_percent, 10);
    assert.equal(promo.max_redemptions, 1);
    assert.equal(promo.reserved_redemptions, 0);
    assert.equal(promo.redeemed_count, 0);
    if (!promo.active) {
      await merchantPage.getByRole('button', { name: 'Enable code', exact: true }).click();
      await merchantPage.getByText('Promo code saved', { exact: true }).waitFor({ timeout: 15000 });
      promo = await queryPromo(fixture.restaurant.id);
    }
    assert.equal(promo.active, true, 'The saved promo must be enabled before customer quote tests');
    report.stages.push('merchant created one-use 10% promotion in the app');

    const customerProfileEmail = `cena-e2e-profile-${runId}-${browserName}@cena.test`;
    customerPage = await context.newPage();
    await createRoutes(customerPage);
    await customerPage.goto(customerOrigin, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await customerPage.getByRole('button', { name: 'Open account', exact: true }).click();
    await sendAndVerifyAccountOtp(customerPage, customerProfileEmail, '6-digit code', 'Verify and load profile');
    await customerPage.getByPlaceholder('Add your name').fill(`E2E ${browserName} Customer`);
    await customerPage.getByPlaceholder('Add a phone number').fill('5105550147');
    await customerPage.getByRole('button', { name: 'Save profile and privacy choice', exact: true }).click();
    await customerPage.getByText('Your profile and privacy choice are saved.', { exact: true }).waitFor({ timeout: 20000 });
    await customerPage.reload({ waitUntil: 'domcontentloaded' });
    await customerPage.getByPlaceholder('Add your name').waitFor();
    assert.equal(await customerPage.getByPlaceholder('Add your name').inputValue(), `E2E ${browserName} Customer`);
    const profileRows = await queryRows('profiles', 'display_name,phone', { display_name: `eq.E2E ${browserName} Customer`, phone: 'eq.5105550147' });
    assert.ok(profileRows.length > 0, 'Saved profile should be backed by local Supabase');
    await customerPage.getByRole('button', { name: 'Sign out', exact: true }).click();
    report.stages.push('customer OTP profile save and reload persistence passed');

    await customerPage.getByRole('tab', { name: 'Home', exact: true }).click();
    await customerPage.getByRole('button', { name: `View ${fixture.restaurant.name} menu`, exact: true }).waitFor({ timeout: 45000 });
    await customerPage.getByRole('button', { name: `Add ${mealName} to bag`, exact: true }).click();
    await customerPage.getByRole('button', { name: `Add ${mealName} to bag`, exact: true }).click();
    await customerPage.reload({ waitUntil: 'domcontentloaded' });
    await customerPage.getByRole('tab', { name: 'Bag, 2 items', exact: true }).waitFor({ timeout: 30000 });
    await customerPage.getByRole('tab', { name: 'Bag, 2 items', exact: true }).click();
    await customerPage.getByRole('button', { name: `Increase ${mealName} quantity`, exact: true }).waitFor();
    await customerPage.getByText('$33.90', { exact: true }).waitFor();
    report.stages.push('guest browse, bag badge, quantity, and reload persistence passed');

    await startPickupFlow(customerPage);
    const checkoutEmail = `cena-e2e-order-${runId}-${browserName}@cena.test`;
    await customerPage.getByPlaceholder('Email address', { exact: true }).fill(checkoutEmail);
    const terms = customerPage.getByRole('checkbox', { name: 'Agree to the Consumer Terms and Privacy Policy' });
    if (!(await terms.getAttribute('aria-checked')) || (await terms.getAttribute('aria-checked')) === 'false') await terms.click();
    await customerPage.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
    await clickGotIt(customerPage);
    const checkoutOtp = await readOtp(checkoutEmail);
    await customerPage.getByPlaceholder('6-digit email sign-in code').fill(checkoutOtp);
    const noCodeQuotePromise = customerPage.waitForResponse(response => new URL(response.url()).pathname.endsWith('/v1/checkout/quote'), { timeout: 30000 });
    await customerPage.getByRole('button', { name: 'Verify code and continue', exact: true }).click();
    const noCodeQuoteResponse = await noCodeQuotePromise;
    assert.ok(noCodeQuoteResponse.ok(), 'No-code checkout quote should succeed');
    const noCodeQuote = await noCodeQuoteResponse.json();
    assert.equal(noCodeQuote.subtotal_cents, 1695 * 2);
    assert.equal(noCodeQuote.discount_cents, 0);
    assert.equal(noCodeQuote.amount_cents, 1695 * 2);
    report.stages.push('checkout customer email OTP passed');
    report.stages.push('no-code Go quote returned the undiscounted exact subtotal');

    await customerPage.getByLabel('Restaurant discount code').fill('INVALIDQA');
    const invalidQuotePromise = customerPage.waitForResponse(response => new URL(response.url()).pathname.endsWith('/v1/checkout/quote'), { timeout: 30000 });
    await customerPage.getByRole('button', { name: 'Apply code & review total', exact: true }).click();
    const invalidQuote = await invalidQuotePromise;
    assert.ok(!invalidQuote.ok(), 'Unavailable promo should not produce a checkout quote');
    await customerPage.getByText(/code|promo|unavailable|data service/i).last().waitFor({ timeout: 15000 });

    await customerPage.getByLabel('Restaurant discount code').fill(promoCode);
    const quotePromise = customerPage.waitForResponse(response => new URL(response.url()).pathname.endsWith('/v1/checkout/quote'), { timeout: 30000 });
    await customerPage.getByRole('button', { name: 'Apply code & review total', exact: true }).click();
    const quoteResponse = await quotePromise;
    assert.ok(quoteResponse.ok(), `Valid promotion quote failed (${quoteResponse.status()})`);
    const quote = await quoteResponse.json();
    const expectedSubtotalCents = 1695 * 2;
    const expectedDiscountCents = Math.round(expectedSubtotalCents * 0.10);
    const expectedAmountCents = expectedSubtotalCents - expectedDiscountCents;
    assert.equal(quote.subtotal_cents, expectedSubtotalCents);
    assert.equal(quote.discount_cents, expectedDiscountCents, '10% promotion math must be exact');
    assert.equal(quote.amount_cents, expectedAmountCents);
    assert.equal(quote.promo_code, promoCode);
    await customerPage.getByText(`−$${(expectedDiscountCents / 100).toFixed(2)}`, { exact: true }).waitFor();
    await customerPage.getByText(`$${(expectedAmountCents / 100).toFixed(2)}`, { exact: true }).last().waitFor();
    report.stages.push('invalid promo rejected and 10% quote matched exact cents');

    async function createCheckout() {
      const responsePromise = customerPage.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === '/v1/checkout' && response.request().method() === 'POST';
      }, { timeout: 45000 });
      await customerPage.getByRole('button', { name: /Continue to secure payment/ }).click();
      const response = await responsePromise;
      const body = await response.json();
      const requestBody = response.request().postDataJSON();
      const requestHeaders = await response.request().allHeaders();
      const token = requestHeaders.authorization?.replace(/^Bearer\s+/i, '');
      assert.ok(response.ok(), `Checkout creation failed (${response.status()})`);
      assert.ok(body.order_id && body.checkout_url, 'Checkout must return a pending order and trusted fake Stripe URL');
      assert.equal(requestBody.expected_amount_cents, expectedAmountCents);
      assert.equal(requestBody.promo_code, promoCode);
      return { body, requestBody, token };
    }

    const firstCheckout = await createCheckout();
    assert.ok(firstCheckout.token, 'Customer auth bearer should be present on checkout request');
    orderId = firstCheckout.body.order_id;
    customerToken = firstCheckout.token;
    customerUserId = decodeJwt(customerToken).sub;
    const statusResponse = await context.request.get(`${apiOrigin}/v1/checkout/${orderId}`, {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    assert.ok(statusResponse.ok());
    assert.equal((await statusResponse.json()).status, 'pending');
    const firstOrder = await queryOrder(orderId);
    assert.equal(firstOrder.payment_status, 'pending');
    assert.equal(firstOrder.total_cents, expectedAmountCents);
    const reservedPromo = await queryPromo(fixture.restaurant.id);
    assert.equal(reservedPromo.reserved_redemptions, 1);
    assert.equal(reservedPromo.redeemed_count, 0);

    const merchantOrderQuery = new URLSearchParams({ select: 'id', id: `eq.${orderId}` });
    const hiddenResponse = await fetch(`${supabase.apiUrl}/rest/v1/orders?${merchantOrderQuery}`, {
      headers: { apikey: supabase.anonKey, authorization: `Bearer ${merchantToken}` },
    });
    assert.ok(hiddenResponse.ok());
    assert.deepEqual(await hiddenResponse.json(), [], 'Merchant must not see an unpaid checkout');

    const sessionCountBeforeReplay = fake.audit.filter(entry => entry.kind === 'checkout_session' && entry.orderId === orderId).length;
    const replayResponse = await context.request.post(`${apiOrigin}/v1/checkout`, {
      headers: { authorization: `Bearer ${customerToken}`, 'content-type': 'application/json' },
      data: firstCheckout.requestBody,
    });
    assert.ok(replayResponse.ok(), 'Idempotent retry should resume the same Checkout Session');
    assert.equal((await replayResponse.json()).order_id, orderId);
    assert.equal(fake.audit.filter(entry => entry.kind === 'checkout_session' && entry.orderId === orderId).length, sessionCountBeforeReplay);
    report.stages.push('pending status, idempotent replay, and merchant invisibility passed');

    customerPage = await getLocalAppPage(new URL(customerOrigin).port, customerPage, customerOrigin);
    await customerPage.getByText('Finish secure payment', { exact: true }).waitFor({ timeout: 30000 });
    await customerPage.getByRole('button', { name: 'Cancel checkout', exact: true }).click();
    await waitUntil(async () => fake.audit.some(entry => entry.kind === 'session_expire'));
    const expiredStatus = await context.request.get(`${apiOrigin}/v1/checkout/${orderId}`, {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    assert.equal((await expiredStatus.json()).status, 'expired');
    const releasedPromo = await queryPromo(fixture.restaurant.id);
    assert.equal(releasedPromo.reserved_redemptions, 0, 'Cancelled checkout should release its reserved code');
    assert.equal(releasedPromo.redeemed_count, 0);
    report.stages.push('customer cancelled a pending checkout; provider expiry released promo reservation');

    customerPage = await getLocalAppPage(new URL(customerOrigin).port, customerPage, customerOrigin);
    await customerPage.getByRole('tab', { name: 'Bag, 2 items', exact: true }).waitFor({ timeout: 30000 });
    await startPickupFlow(customerPage);
    await customerPage.getByPlaceholder('Email address', { exact: true }).fill(checkoutEmail).catch(() => {});
    const termsAfterRetry = customerPage.getByRole('checkbox', { name: 'Agree to the Consumer Terms and Privacy Policy' });
    if ((await termsAfterRetry.getAttribute('aria-checked')) === 'false') await termsAfterRetry.click();
    await customerPage.getByLabel('Restaurant discount code').fill(promoCode);
    const retryQuotePromise = customerPage.waitForResponse(response => new URL(response.url()).pathname.endsWith('/v1/checkout/quote'), { timeout: 30000 });
    await customerPage.getByRole('button', { name: 'Review total', exact: true }).click().catch(async () => {
      await customerPage.getByRole('button', { name: 'Apply code & review total', exact: true }).click();
    });
    const retryQuoteResponse = await retryQuotePromise;
    assert.ok(retryQuoteResponse.ok());
    assert.equal((await retryQuoteResponse.json()).amount_cents, expectedAmountCents);
    const paidCheckout = await createCheckout();
    const paidOrderId = paidCheckout.body.order_id;
    assert.notEqual(paidOrderId, orderId, 'Retry after expiry should reserve a fresh order');
    const paidPromoReservation = await queryPromo(fixture.restaurant.id);
    assert.equal(paidPromoReservation.reserved_redemptions, 1);

    const checkoutSessionId = new URL(paidCheckout.body.checkout_url).pathname.split('/').filter(Boolean).at(-1);
    let checkoutPage = context.pages().find(candidate => candidate.url().includes(checkoutSessionId));
    if (!checkoutPage) checkoutPage = await waitForExternalPage(context, 'checkout.stripe.com', 12000);
    if (checkoutPage && !checkoutPage.url().includes(checkoutSessionId)) checkoutPage = null;
    if (!checkoutPage) {
      checkoutPage = await context.newPage();
      await createRoutes(checkoutPage);
      await checkoutPage.goto(paidCheckout.body.checkout_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await checkoutPage.getByRole('button', { name: 'Pay with fake test card', exact: true }).click({ timeout: 30000 });
    await waitUntil(async () => fake.audit.some(entry => entry.kind === 'webhook' && entry.orderId === paidOrderId && entry.status === 200));
    const paidSessionLog = fake.audit.find(entry => entry.kind === 'checkout_session' && entry.orderId === paidOrderId);
    assert.ok(paidSessionLog);
    assert.equal(paidSessionLog.amountCents, expectedAmountCents);
    assert.equal(paidSessionLog.feeCents, 175);
    const accountRows = await queryRows('restaurant_payment_accounts', 'stripe_account_id,application_fee_cents', { restaurant_id: `eq.${fixture.restaurant.id}` });
    assert.equal(accountRows.length, 1);
    assert.equal(accountRows[0].stripe_account_id, paidSessionLog.account, 'Checkout must be created on the restaurant Stripe account');
    assert.equal(accountRows[0].application_fee_cents, 175);
    await waitUntil(async () => (await queryOrder(paidOrderId)).payment_status === 'paid');
    const paidOrder = await queryOrder(paidOrderId);
    assert.equal(paidOrder.status, 'placed');
    assert.equal(paidOrder.subtotal_cents, expectedSubtotalCents);
    assert.equal(paidOrder.discount_cents, expectedDiscountCents);
    assert.equal(paidOrder.total_cents, expectedAmountCents);
    assert.equal(paidOrder.promo_code_snapshot, promoCode);
    assert.equal(paidOrder.application_fee_cents, 175);
    const redeemedPromo = await queryPromo(fixture.restaurant.id);
    assert.equal(redeemedPromo.reserved_redemptions, 0);
    assert.equal(redeemedPromo.redeemed_count, 1);
    customerPage = await getLocalAppPage(new URL(customerOrigin).port, customerPage, customerOrigin);
    await customerPage.getByRole('tab', { name: 'Orders', exact: true }).click();
    await customerPage.getByText('Paid · awaiting kitchen', { exact: true }).waitFor({ timeout: 30000 });
    await customerPage.getByText(`$${(expectedAmountCents / 100).toFixed(2)}`, { exact: true }).last().waitFor();
    report.stages.push('fake Checkout form paid; signed Stripe webhook verified and promoted order to paid');

    const badCancel = await context.request.patch(`${apiOrigin}/v1/orders/${paidOrderId}/status`, {
      headers: { authorization: `Bearer ${merchantToken}`, 'content-type': 'application/json' },
      data: { status: 'cancelled' },
    });
    assert.ok(!badCancel.ok(), 'Paid orders must reject cancellation without a refund');
    assert.equal((await queryOrder(paidOrderId)).payment_status, 'paid');

    await reloadRestaurantData();
    const ordersTab = merchantPage.getByText('Orders', { exact: true });
    await ordersTab.click();
    const orderPrefix = paidOrderId.slice(0, 8).toUpperCase();
    await merchantPage.getByText(orderPrefix, { exact: false }).waitFor({ timeout: 30000 });
    await merchantPage.getByText(orderPrefix, { exact: false }).first().click();
    await merchantPage.getByText('Paid online · Cena flat fee $1.75', { exact: true }).waitFor();
    await merchantPage.getByRole('button', { name: 'Accept order', exact: true }).click();
    await merchantPage.getByText(orderPrefix, { exact: false }).first().click();
    await merchantPage.getByRole('button', { name: 'Start preparing', exact: true }).click();
    await merchantPage.getByText(orderPrefix, { exact: false }).first().click();
    await merchantPage.getByRole('button', { name: 'Mark ready', exact: true }).click();
    await merchantPage.getByText(orderPrefix, { exact: false }).first().click();
    await merchantPage.getByRole('button', { name: 'Cancel and refund', exact: true }).click();
    await merchantPage.getByRole('button', { name: 'Keep order', exact: true }).click();
    assert.equal(fake.audit.filter(entry => entry.kind === 'refund').length, 0, 'Dismissed refund confirmation must not contact Stripe');
    await merchantPage.getByText(orderPrefix, { exact: false }).first().click();
    await merchantPage.getByRole('button', { name: 'Cancel and refund', exact: true }).click();
    await merchantPage.getByRole('button', { name: 'Confirm refund and cancel', exact: true }).click();
    await waitUntil(async () => (await queryOrder(paidOrderId)).payment_status === 'refunded');
    assert.equal((await queryOrder(paidOrderId)).status, 'cancelled');
    assert.equal(fake.audit.filter(entry => entry.kind === 'refund').length, 1);
    report.stages.push('merchant accepted/prepared/readied order; unsafe cancel rejected; refund confirmation guard and fake refund passed');

    customerPage = await getLocalAppPage(8081, customerPage, customerOrigin);
    await customerPage.getByRole('tab', { name: 'Orders', exact: true }).click().catch(() => {});
    await customerPage.getByText('Refunded', { exact: true }).waitFor({ timeout: 30000 });
    const customerHistory = await queryRows('orders', 'id,payment_status,status', { id: `eq.${paidOrderId}`, user_id: `eq.${customerUserId}` });
    assert.equal(customerHistory.length, 1);
    await customerPage.screenshot({ path: `${artifactsDir}/${browserName}-customer-refunded.png`, fullPage: true });
    await merchantPage.screenshot({ path: `${artifactsDir}/${browserName}-restaurant-refunded.png`, fullPage: true });

    const checkoutAudit = fake.audit.find(entry => entry.kind === 'checkout_session' && entry.orderId === paidOrderId);
    const webhookAudit = fake.audit.find(entry => entry.kind === 'webhook' && entry.orderId === paidOrderId && entry.status === 200);
    assert.ok(checkoutAudit && webhookAudit);
    assert.deepEqual(errors, [], `Unexpected browser runtime errors: ${errors.join('; ')}`);
    assert.deepEqual(networkBlocks, [], `Browser attempted non-loopback requests: ${networkBlocks.join(', ')}`);
    report.orderId = paidOrderId;
    report.amountCents = expectedAmountCents;
    report.subtotalCents = expectedSubtotalCents;
    report.discountCents = expectedDiscountCents;
    report.applicationFeeCents = 175;
    report.connectedAccount = checkoutAudit.account;
    report.webhookStatus = webhookAudit.status;
    report.finalStatus = 'refunded';
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    if (orderId && customerToken) {
      try {
        const status = await fetch(`${apiOrigin}/v1/checkout/${orderId}`, { headers: { authorization: `Bearer ${customerToken}` } });
        if (status.ok && (await status.json()).status === 'pending') {
          await fetch(`${apiOrigin}/v1/checkout/${orderId}`, { method: 'DELETE', headers: { authorization: `Bearer ${customerToken}` } });
        }
      } catch { /* Preserve the original failure and leave local QA data visible for diagnosis. */ }
    }
    for (const [name, page] of [['customer', customerPage], ['restaurant', merchantPage]]) {
      if (page && !page.isClosed()) await page.screenshot({ path: `${artifactsDir}/${browserName}-${name}-failure.png`, fullPage: true }).catch(() => {});
    }
    throw new Error(`${report.error}; completed stages: ${report.stages.join(' > ')}; API trace: ${apiTrace.slice(-20).join(' | ')}`);
  } finally {
    if (fixtureRestaurantId) {
      await serviceRequest(`/rest/v1/restaurants?id=eq.${fixtureRestaurantId}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ active: false }),
      }).catch(() => {});
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function waitForExternalPage(context, hostname, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const page = context.pages().find(candidate => {
      try { return new URL(candidate.url()).hostname === hostname; } catch { return false; }
    });
    if (page) return page;
    await delay(200);
  }
  return null;
}

async function waitUntil(predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(250);
  }
  throw new Error('Timed out waiting for local E2E state to settle');
}

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

function decodeJwt(token) {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('Local auth access token was not a JWT');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}
