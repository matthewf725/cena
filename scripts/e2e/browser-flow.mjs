import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium, webkit } from 'playwright';

const browserTypes = { chromium, webkit };
const mailpitOrigin = 'http://127.0.0.1:54324';
const restaurantSlug = 'sunrise-cafe';
const mealName = 'Rigatoni alla Vodka Kit';
const sanitizeDiagnostic = value => value
  .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{80,}\b/g, '[redacted-token]')
  .replace(/([?&](?:apikey|access_token|refresh_token|code)=)[^&\s]+/gi, '$1[redacted]')
  .slice(0, 260);

export async function runBrowserFlow({ browserName, supabase, serviceRoleKey, apiOrigin, customerOrigin = process.env.CENA_E2E_CUSTOMER_ORIGIN || 'http://localhost:8081', restaurantOrigin = process.env.CENA_E2E_RESTAURANT_ORIGIN || 'http://localhost:8082', fake, runId, artifactsDir }) {
  const type = browserTypes[browserName];
  if (!type) throw new Error(`Unsupported browser ${browserName}`);
  const browser = await type.launch({ headless: process.env.CENA_E2E_HEADLESS !== '0' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const errors = [];
  const browserDiagnostics = [];
  const networkBlocks = [];
  const apiTrace = [];
  const externalPages = [];
  let routesInstalled = false;
  context.on('response', response => {
    try {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/v1/')) apiTrace.push(`${response.request().method()} ${url.host}${url.pathname} -> ${response.status()}`);
      else if (url.pathname.startsWith('/auth/v1/')) apiTrace.push(`${response.request().method()} ${url.host}${url.pathname} -> ${response.status()}`);
    } catch { /* non-http response */ }
  });
  context.on('requestfailed', request => {
    try {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/auth/v1/')) apiTrace.push(`${request.method()} ${url.host}${url.pathname} failed: ${request.failure()?.errorText || 'network error'}`);
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
  const mark = stage => { report.stages.push(stage); console.log(`[${browserName}] ${stage}`); };

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
    const restaurants = await serviceRequest(`/rest/v1/restaurants?select=id,name,slug,latitude,longitude&slug=eq.${restaurantSlug}&active=eq.true&limit=1`);
    assert.equal(restaurants.length, 1, `Seed restaurant ${restaurantSlug} must exist locally`);
    const source = restaurants[0];
    const sourceItems = await serviceRequest(`/rest/v1/catalog_items?select=*&restaurant_id=eq.${source.id}&name=eq.${encodeURIComponent(mealName)}&active=eq.true&limit=1`);
    assert.equal(sourceItems.length, 1, `Seed menu item ${mealName} must exist locally`);
    const sourceSlots = await serviceRequest(`/rest/v1/pickup_slots?select=*&restaurant_id=eq.${source.id}&active=eq.true&cutoff_at=gt.${encodeURIComponent(new Date().toISOString())}&order=starts_at.asc&limit=1`);
    assert.ok(sourceSlots.length, `Seed restaurant ${source.slug} needs a future pickup slot`);
    const restaurantRows = await serviceRequest('/rest/v1/restaurants?select=id,name,slug,latitude,longitude', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ slug: `cena-e2e-${runId}-${browserName}`, name: `QA Sunrise ${runId.slice(-6)} ${browserName}`, description: 'Disposable local browser QA restaurant.', cuisine: 'Cafe', image_key: 'sunrise-cafe-cover', timezone: 'America/Los_Angeles', address: 'Local QA only', latitude: source.latitude, longitude: source.longitude, curbside_enabled: true, active: true }),
    });
    const restaurant = restaurantRows[0];
    const sourceItem = sourceItems[0];
    const itemRows = await serviceRequest('/rest/v1/catalog_items?select=id', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ restaurant_id: restaurant.id, name: sourceItem.name, description: sourceItem.description, price_cents: sourceItem.price_cents, regular_price_cents: sourceItem.regular_price_cents, equipment: sourceItem.equipment, allergens: sourceItem.allergens, published_steps: sourceItem.published_steps, image_key: sourceItem.image_key, image_url: sourceItem.image_url, category: sourceItem.category, active: true, prep_minutes: sourceItem.prep_minutes, published_at: new Date().toISOString() }),
    });
    const itemId = itemRows[0].id;
    const sourceSlot = sourceSlots[0];
    const slotStartsAt = new Date(Date.now() + 90 * 60 * 1000);
    const slotEndsAt = new Date(slotStartsAt.getTime() + 30 * 60 * 1000);
    const slotCutoffAt = new Date(slotStartsAt.getTime() - 60 * 60 * 1000);
    const slotRows = await serviceRequest('/rest/v1/pickup_slots?select=id', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ restaurant_id: restaurant.id, starts_at: slotStartsAt.toISOString(), ends_at: slotEndsAt.toISOString(), cutoff_at: slotCutoffAt.toISOString(), capacity: sourceSlot.capacity, active: true }),
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
    return { email, password, restaurant, itemId, slotId: slotRows[0].id, availableQty: sourceSlot.capacity };
  }

  async function createRoutes(page) {
    page.on('pageerror', error => errors.push(`pageerror: ${sanitizeDiagnostic(error.message)}`));
    page.on('console', message => {
      if (message.type() === 'error') {
        const location = message.location();
        let source = '';
        try {
          const url = new URL(location.url);
          source = `${url.origin}${url.pathname}:${location.lineNumber || 0}:${location.columnNumber || 0}`;
        } catch { /* console message without a source URL */ }
        browserDiagnostics.push(`console: ${sanitizeDiagnostic(message.text())}${source ? ` @ ${source}` : ''}`);
      }
    });
    page.on('requestfailed', request => {
      const url = new URL(request.url());
      if (!['http:', 'https:'].includes(url.protocol)) return;
      browserDiagnostics.push(`requestfailed: ${url.origin}${url.pathname} (${sanitizeDiagnostic(request.failure()?.errorText || 'network error')})`);
    });
    if (routesInstalled) return;
    routesInstalled = true;
    await context.route('**/*', async route => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.hostname === 'checkout.stripe.com') {
        if (requestUrl.pathname.startsWith('/__qa/pay/')) {
          try {
            const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, fake.origin);
            const upstream = await route.fetch({ url: target.toString(), method: 'POST', maxRedirects: 0, timeout: 10000 });
            await route.fulfill({ response: upstream });
          } catch (error) {
            networkBlocks.push(`Fake Stripe payment proxy failed: ${error instanceof Error ? error.message : String(error)}`);
            await route.abort('failed').catch(() => {});
          }
          return;
        }
        const sessionId = requestUrl.pathname.split('/').filter(Boolean).at(-1);
        const current = context.pages().find(candidate => candidate.url().includes('checkout.stripe.com')) || page;
        externalPages.push(current);
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><meta name="viewport" content="width=device-width"><main><h1>Fake Stripe Checkout</h1><p>Local QA only. No card details are collected.</p><button id="pay">Pay with fake test card</button><p id="result" aria-live="polite"></p></main><script>document.querySelector('#pay').addEventListener('click',async()=>{const b=document.querySelector('#pay');b.disabled=true;const r=await fetch('/__qa/pay/${sessionId}',{method:'POST'});const v=await r.json();document.querySelector('#result').textContent=v.paid?'Fake payment confirmed':'Fake payment was not confirmed';if(v.paid)setTimeout(()=>{if(window.opener){window.opener.location.href='${customerOrigin}';window.close()}else location.href='${customerOrigin}'},250);});</script>`,
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

      if ((requestUrl.pathname.startsWith('/v1/') || requestUrl.pathname === '/healthz') && ['localhost', '127.0.0.1', '::1'].includes(requestUrl.hostname)) {
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
    const gotIt = page.getByText('Got it', { exact: true });
    await gotIt.waitFor({ state: 'visible', timeout: 15000 });
    await gotIt.click();
    await gotIt.waitFor({ state: 'hidden', timeout: 10000 });
  }

  async function sendAndVerifyAccountOtp(page, email, codeInput, verifyButton) {
    await page.getByPlaceholder('Add an email address').fill(email);
    const sendResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/auth/v1/otp') && response.request().method() === 'POST', { timeout: 30000 });
    await page.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
    const sendResponse = await sendResponsePromise;
    mark(`account OTP send returned ${sendResponse.status()}`);
    assert.ok(sendResponse.ok(), 'Local Supabase should accept the OTP request');
    const code = await readOtp(email);
    await page.getByPlaceholder(codeInput).fill(code);
    const verifyResponsePromise = page.waitForResponse(response => {
      const pathname = new URL(response.url()).pathname;
      return (pathname.endsWith('/auth/v1/verify') || pathname.endsWith('/auth/v1/token')) && response.request().method() === 'POST';
    }, { timeout: 30000 });
    await page.getByRole('button', { name: verifyButton, exact: true }).click();
    const verifyResponse = await verifyResponsePromise;
    mark(`account OTP verify returned ${verifyResponse.status()}`);
    assert.ok(verifyResponse.ok(), 'Local Supabase OTP verification should succeed');
    await page.waitForFunction(() => {
      for (let index = 0; index < localStorage.length; index += 1) {
        try { if (JSON.parse(localStorage.getItem(localStorage.key(index)) || 'null')?.access_token) return true; }
        catch { /* unrelated local storage entry */ }
      }
      return false;
    }, undefined, { timeout: 15000 });
    mark('Supabase browser session persisted after OTP');
  }

  async function openAccountIfClosed(page) {
    const nameField = page.getByPlaceholder('Add your name');
    const fieldCount = await nameField.count();
    mark(`profile name field count before Account reopen: ${fieldCount}`);
    if (fieldCount) return;
    const openButton = page.getByRole('button', { name: 'Open account', exact: true });
    await openButton.waitFor({ state: 'visible', timeout: 30000 });
    mark('Open account header control visible after hydration');
    await openButton.click();
    mark('clicked Open account to show profile');
    await nameField.waitFor({ timeout: 15000 });
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
    const rows = await queryRows('restaurant_promotions', 'id,code,discount_percent,starts_at,max_redemptions,reserved_redemptions,redeemed_count,active', {
      restaurant_id: `eq.${restaurantId}`, code: `eq.${promoCode}`,
    });
    assert.equal(rows.length, 1, `Synthetic promotion ${promoCode} should exist`);
    return rows[0];
  }

  async function reloadRestaurantData() {
    const refresh = merchantPage.getByRole('button', { name: 'Refresh restaurant data', exact: true });
    const promotionLoad = merchantPage.waitForResponse(response => new URL(response.url()).pathname.endsWith('/rest/v1/rpc/list_restaurant_promotions'), { timeout: 30000 });
    await refresh.click();
    const promotionResponse = await promotionLoad;
    assert.ok(promotionResponse.ok(), `Restaurant refresh promotion load failed (${promotionResponse.status()})`);
    await waitUntil(() => refresh.isEnabled(), 30000);
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
    mark('local synthetic merchant fixture provisioned');
    const fixtureDiscoveryResponse = await fetch(`${apiOrigin}/v1/discovery`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p_latitude: fixture.restaurant.latitude, p_longitude: fixture.restaurant.longitude, p_query: fixture.restaurant.name, p_recent_ids: [] }),
    });
    assert.ok(fixtureDiscoveryResponse.ok, `Synthetic restaurant discovery probe failed (${fixtureDiscoveryResponse.status})`);
    const fixtureDiscovery = await fixtureDiscoveryResponse.json();
    const visibleRestaurants = [
      ...(fixtureDiscovery.nearby || []).map(card => card.name),
      ...(fixtureDiscovery.explore || []).map(entry => entry.restaurant?.name),
    ];
    assert.ok(visibleRestaurants.includes(fixture.restaurant.name), `Seeded Go discovery search did not find ${fixture.restaurant.name}`);
    mark('synthetic restaurant and fresh slot visible through Go discovery search');

    merchantPage = await context.newPage();
    await createRoutes(merchantPage);
    const authResponses = [];
    merchantPage.on('response', response => {
      if (response.url().includes('/auth/v1/token') && response.request().method() === 'POST') authResponses.push(response);
    });
    await merchantPage.goto(restaurantOrigin, { waitUntil: 'domcontentloaded', timeout: 120000 });
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
    mark('restaurant owner signed in');
    await merchantPage.getByText('Manage', { exact: true }).click();
    await merchantPage.getByText('Payments & payouts', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    mark('restaurant Manage screen opened');

    const readyText = merchantPage.getByText('Stripe connected · ready for online orders', { exact: true });
    if (!(await readyText.count())) {
      const connect = merchantPage.getByRole('button', { name: 'Connect Stripe', exact: true });
      await connect.click();
      const externalConnect = await waitForExternalPage(context, 'connect.stripe.com', 12000);
      if (externalConnect) {
        await externalConnect.getByRole('button', { name: 'Return to restaurant', exact: true }).click().catch(() => {});
      }
      await reloadRestaurantData();
    }
    await readyText.waitFor({ timeout: 30000 });
    await merchantPage.getByText(/Cena fee: \$1\.75 per paid order\./).waitFor({ timeout: 15000 });
    mark('merchant payment readiness displayed with $1.75 fee');

    await merchantPage.getByRole('button', { name: '+ Add code', exact: true }).click();
    const promoModalTitle = merchantPage.getByText('New promo code', { exact: true });
    await promoModalTitle.waitFor({ state: 'visible', timeout: 10000 });
    const promoStartField = merchantPage.getByLabel('STARTS (LOCAL TIME)');
    const promoStartValue = await merchantPage.evaluate(() => {
      const d = new Date();
      const part = value => String(value).padStart(2, '0');
      return `${d.getFullYear()}-${part(d.getMonth() + 1)}-${part(d.getDate())} ${part(d.getHours())}:${part(d.getMinutes())}`;
    });
    await promoStartField.fill(promoStartValue);
    await merchantPage.getByLabel('CODE (3–32 CHARACTERS)').fill(promoCode);
    await merchantPage.getByLabel('DISCOUNT PERCENT (1–90)').fill('10');
    await merchantPage.getByLabel('MAX REDEMPTIONS (OPTIONAL)').fill('1');
    const savePromoResponsePromise = merchantPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname.endsWith('/rest/v1/rpc/save_restaurant_promotion') && response.request().method() === 'POST';
    }, { timeout: 20000 }).catch(error => error);
    const savePromo = merchantPage.getByRole('button', { name: 'Save promo code', exact: true });
    await merchantPage.mouse.move(200, 800);
    await merchantPage.mouse.wheel(0, 700);
    await merchantPage.waitForTimeout(250);
    const savePromoBox = await savePromo.boundingBox();
    const promoViewport = merchantPage.viewportSize();
    assert.ok(savePromoBox && promoViewport && savePromoBox.x >= 0 && savePromoBox.y >= 0 &&
      savePromoBox.x + savePromoBox.width <= promoViewport.width && savePromoBox.y + savePromoBox.height <= promoViewport.height,
    `Save promo button must fit the ${promoViewport?.width}×${promoViewport?.height} viewport after normal modal scroll; box ${JSON.stringify(savePromoBox)}`);
    mark('promo save button fits the viewport');
    const saveClickResult = await savePromo.click({ timeout: 15000 }).then(() => null, error => error);
    const savePromoResponse = await savePromoResponsePromise;
    if (savePromoResponse instanceof Error) throw new Error(`Save promo did not reach Supabase (${saveClickResult?.message || 'no response'}): ${savePromoResponse.message}`);
    assert.ok(savePromoResponse.ok(), `Save promo RPC failed (${savePromoResponse.status()})`);
    if (saveClickResult) mark('promo save completed before its closing modal detached');
    let promo = await queryPromo(fixture.restaurant.id);
    assert.equal(promo.discount_percent, 10);
    assert.equal(promo.max_redemptions, 1);
    assert.equal(promo.reserved_redemptions, 0);
    assert.equal(promo.redeemed_count, 0);
    if (!promo.active) {
      const enablePromoResponsePromise = merchantPage.waitForResponse(response => new URL(response.url()).pathname.endsWith('/rest/v1/rpc/save_restaurant_promotion') && response.request().method() === 'POST', { timeout: 20000 });
      await merchantPage.getByRole('button', { name: 'Enable code', exact: true }).click();
      const enablePromoResponse = await enablePromoResponsePromise;
      assert.ok(enablePromoResponse.ok(), `Enable promo RPC failed (${enablePromoResponse.status()})`);
      promo = await queryPromo(fixture.restaurant.id);
    }
    assert.equal(promo.active, true, 'The saved promo must be enabled before customer quote tests');
    assert.ok(Date.parse(promo.starts_at) <= Date.now(), 'The enabled test promotion must be available immediately');
    assert.ok(Date.parse(promo.starts_at) <= Date.now(), 'The enabled test promotion must be available immediately');
    mark('merchant created one-use 10% promotion in the app');

    customerPage = await context.newPage();
    await createRoutes(customerPage);
    await customerPage.goto(customerOrigin, { waitUntil: 'domcontentloaded', timeout: 180000 });
    mark('customer document DOM content loaded');
    await customerPage.getByRole('tab', { name: 'Home', exact: true }).waitFor({ state: 'visible', timeout: 90000 });
    await customerPage.getByRole('tab', { name: 'Home', exact: true }).click();
    await customerPage.getByLabel('Search restaurants and meal kits').fill(fixture.restaurant.name);
    const restaurantCard = customerPage.getByRole('button', { name: `View ${fixture.restaurant.name} menu`, exact: true }).first();
    await restaurantCard.waitFor({ timeout: 45000 });
    await restaurantCard.click();
    await customerPage.getByRole('button', { name: `Add ${mealName} to bag`, exact: true }).waitFor({ timeout: 30000 });
    await customerPage.getByRole('button', { name: `Add ${mealName} to bag`, exact: true }).click();
    await customerPage.getByRole('button', { name: `Add ${mealName} to bag`, exact: true }).click();
    await customerPage.reload({ waitUntil: 'domcontentloaded' });
    await customerPage.getByRole('tab', { name: 'Bag, 2 items', exact: true }).waitFor({ timeout: 30000 });
    await customerPage.getByRole('tab', { name: 'Bag, 2 items', exact: true }).click();
    await customerPage.getByRole('button', { name: `Increase ${mealName} quantity`, exact: true }).waitFor();
    await customerPage.getByText('$33.90', { exact: true }).first().waitFor();
    mark('guest browse, bag badge, quantity, and reload persistence passed');

    await startPickupFlow(customerPage);
    const checkoutEmail = `cena-e2e-order-${runId}-${browserName}@cena.test`;
    mark('pickup slot and checkout contact step opened');
    await customerPage.getByPlaceholder('Email address', { exact: true }).fill(checkoutEmail);
    const terms = customerPage.getByRole('checkbox', { name: 'Agree to the Consumer Terms and Privacy Policy' });
    if (!(await terms.getAttribute('aria-checked')) || (await terms.getAttribute('aria-checked')) === 'false') await terms.click();
    const checkoutOtpSendPromise = customerPage.waitForResponse(response => new URL(response.url()).pathname.endsWith('/auth/v1/otp') && response.request().method() === 'POST', { timeout: 30000 });
    await customerPage.getByRole('button', { name: 'Email me a sign-in code', exact: true }).click();
    const checkoutOtpSend = await checkoutOtpSendPromise;
    mark(`checkout OTP send returned ${checkoutOtpSend.status()}`);
    assert.ok(checkoutOtpSend.ok(), 'Local Supabase should accept the checkout OTP request');
    await customerPage.getByText('Check your email for a six-digit sign-in code.', { exact: true }).waitFor({ timeout: 10000 });
    const checkoutResend = customerPage.getByRole('button', { name: 'Send a new code', exact: true });
    assert.equal(await checkoutResend.isDisabled(), true, 'Checkout resend must be rate limited immediately after sending');
    const checkoutOtp = await readOtp(checkoutEmail);
    mark('checkout OTP received from local Mailpit');
    const wrongCheckoutOtp = checkoutOtp === '000000' ? '111111' : '000000';
    await customerPage.getByPlaceholder('6-digit email sign-in code').fill(wrongCheckoutOtp);
    const wrongCheckoutOtpVerifyPromise = customerPage.waitForResponse(response => {
      const pathname = new URL(response.url()).pathname;
      return (pathname.endsWith('/auth/v1/verify') || pathname.includes('/auth/v1/token')) && response.request().method() === 'POST';
    }, { timeout: 30000 });
    await customerPage.getByRole('button', { name: 'Verify code and continue', exact: true }).click();
    const wrongCheckoutOtpVerify = await wrongCheckoutOtpVerifyPromise;
    assert.ok(!wrongCheckoutOtpVerify.ok(), 'An incorrect checkout OTP must be rejected');
    await customerPage.getByText('That code didn’t work. Check the digits or request a new code.', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await checkoutResend.isDisabled(), true, 'Resend must stay disabled during its cooldown after an incorrect code');
    mark('wrong checkout OTP rejected with inline feedback while resend stayed disabled');

    await customerPage.getByPlaceholder('6-digit email sign-in code').fill(checkoutOtp);
    const checkoutOtpVerifyPromise = customerPage.waitForResponse(response => {
      const pathname = new URL(response.url()).pathname;
      return (pathname.endsWith('/auth/v1/verify') || pathname.includes('/auth/v1/token')) && response.request().method() === 'POST';
    }, { timeout: 30000 }).catch(error => error);
    const noCodeQuotePromise = customerPage.waitForResponse(response => new URL(response.url()).pathname.endsWith('/v1/checkout/quote'), { timeout: 8000 }).catch(() => null);
    mark('submitting checkout OTP code');
    await customerPage.getByRole('button', { name: 'Verify code and continue', exact: true }).click();
    mark(`checkout OTP submit click returned; page ${new URL(customerPage.url()).pathname}`);
    const checkoutOtpVerify = await checkoutOtpVerifyPromise;
    if (checkoutOtpVerify instanceof Error) {
      const detailsVisible = await customerPage.getByText(/3\s+DETAILS/i).count().catch(() => 0);
      await customerPage.screenshot({ path: `${artifactsDir}/${browserName}-checkout-otp-submit.png`, fullPage: true }).catch(() => {});
      throw new Error(`No checkout OTP verify response; URL ${customerPage.url()}; 3 DETAILS visible ${detailsVisible > 0}; API trace: ${apiTrace.slice(-20).join(' | ')}`);
    }
    mark(`checkout OTP verify returned ${checkoutOtpVerify.status()}`);
    assert.ok(checkoutOtpVerify.ok(), 'Local Supabase checkout OTP verification should succeed');
    const verifiedCheckoutSession = await checkoutOtpVerify.json();
    customerUserId = verifiedCheckoutSession.user?.id ?? verifiedCheckoutSession.session?.user?.id;
    assert.ok(customerUserId, 'Checkout OTP verification should identify the signed-in customer');
    let noCodeQuoteResponse = await noCodeQuotePromise;
    if (!noCodeQuoteResponse) {
      const reviewTotal = customerPage.getByRole('button', { name: 'Review total', exact: true });
      await reviewTotal.waitFor({ timeout: 15000 });
      mark('OTP verified; Review total CTA is available for the no-code quote');
      const explicitQuotePromise = customerPage.waitForResponse(response => new URL(response.url()).pathname.endsWith('/v1/checkout/quote'), { timeout: 30000 });
      await reviewTotal.click();
      noCodeQuoteResponse = await explicitQuotePromise;
    }
    assert.ok(noCodeQuoteResponse.ok(), 'No-code checkout quote should succeed');
    const noCodeQuote = await noCodeQuoteResponse.json();
    assert.equal(noCodeQuote.subtotal_cents, 1695 * 2);
    assert.equal(noCodeQuote.discount_cents, 0);
    assert.equal(noCodeQuote.amount_cents, 1695 * 2);
    mark('checkout customer email OTP passed');
    mark('no-code Go quote returned the undiscounted exact subtotal');

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
    mark('invalid promo rejected and 10% quote matched exact cents');

    const checkoutSessionsBeforeLateRejection = fake.audit.filter(entry => entry.kind === 'checkout_session').length;
    const pausePromoResponsePromise = merchantPage.waitForResponse(response => new URL(response.url()).pathname.endsWith('/rest/v1/rpc/save_restaurant_promotion') && response.request().method() === 'POST');
    await merchantPage.getByRole('button', { name: 'Pause code', exact: true }).click();
    const pausePromoResponse = await pausePromoResponsePromise;
    assert.ok(pausePromoResponse.ok(), `Merchant disabling promo failed (${pausePromoResponse.status()})`);
    assert.equal((await queryPromo(fixture.restaurant.id)).active, false);

    const lateRejectionPromise = customerPage.waitForResponse(response => new URL(response.url()).pathname === '/v1/checkout' && response.request().method() === 'POST');
    await customerPage.getByRole('button', { name: /Continue to secure payment/ }).click();
    const lateRejection = await lateRejectionPromise;
    assert.equal(lateRejection.status(), 422, 'Checkout must revalidate a promo that changed after its quote');
    await customerPage.getByText('That discount code is unavailable. Check the code or continue without it.', { exact: true }).waitFor({ timeout: 15000 });
    const recoveredNoCodeQuotePromise = customerPage.waitForResponse(response => new URL(response.url()).pathname === '/v1/checkout/quote' && response.request().method() === 'POST', { timeout: 10000 }).catch(() => null);
    await customerPage.getByRole('button', { name: 'Remove code and review total', exact: true }).click();
    assert.equal(await customerPage.getByLabel('Restaurant discount code').inputValue(), '');
    let recoveredNoCodeQuote = await recoveredNoCodeQuotePromise;
    if (!recoveredNoCodeQuote) {
      const reviewTotal = customerPage.getByRole('button', { name: 'Review total', exact: true });
      await reviewTotal.waitFor({ timeout: 15000 });
      const explicitRequotePromise = customerPage.waitForResponse(response => new URL(response.url()).pathname === '/v1/checkout/quote' && response.request().method() === 'POST', { timeout: 30000 });
      await reviewTotal.click();
      recoveredNoCodeQuote = await explicitRequotePromise;
    }
    assert.ok(recoveredNoCodeQuote.ok(), `Discount-free recovery quote failed (${recoveredNoCodeQuote.status()})`);
    assert.equal((await recoveredNoCodeQuote.json()).amount_cents, expectedSubtotalCents);
    await customerPage.getByText('$33.90', { exact: true }).last().waitFor();
    assert.equal((await queryRows('orders', 'id', { user_id: `eq.${customerUserId}` })).length, 0, 'Rejected stale promo must not create an order');
    assert.equal(fake.audit.filter(entry => entry.kind === 'checkout_session').length, checkoutSessionsBeforeLateRejection, 'Rejected stale promo must not create a Stripe Checkout Session');

    const enablePromoResponsePromise = merchantPage.waitForResponse(response => new URL(response.url()).pathname.endsWith('/rest/v1/rpc/save_restaurant_promotion') && response.request().method() === 'POST');
    await merchantPage.getByRole('button', { name: 'Enable code', exact: true }).click();
    const enablePromoResponse = await enablePromoResponsePromise;
    assert.ok(enablePromoResponse.ok(), `Merchant re-enabling promo failed (${enablePromoResponse.status()})`);
    assert.equal((await queryPromo(fixture.restaurant.id)).active, true);
    await customerPage.getByLabel('Restaurant discount code').fill(promoCode);
    const recoveredQuotePromise = customerPage.waitForResponse(response => new URL(response.url()).pathname === '/v1/checkout/quote' && response.request().method() === 'POST');
    await customerPage.getByRole('button', { name: 'Apply code & review total', exact: true }).click();
    const recoveredQuoteResponse = await recoveredQuotePromise;
    assert.ok(recoveredQuoteResponse.ok(), `Recovered promo quote failed (${recoveredQuoteResponse.status()})`);
    assert.equal((await recoveredQuoteResponse.json()).amount_cents, expectedAmountCents);
    mark('late promo rejection returned 422 without creating order/Checkout; customer removed code and successfully re-quoted');

    const checkoutSessionsBeforeStockRejection = fake.audit.filter(entry => entry.kind === 'checkout_session').length;
    const reduceFixtureStock = async availableQty => {
      const updated = await serviceRequest(`/rest/v1/slot_item_inventory?slot_id=eq.${fixture.slotId}&item_id=eq.${fixture.itemId}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ available_qty: availableQty }),
      });
      assert.equal(updated.length, 1, 'The isolated fixture inventory row should update');
    };
    await reduceFixtureStock(1);
    const stockRejectionPromise = customerPage.waitForResponse(response => new URL(response.url()).pathname === '/v1/checkout' && response.request().method() === 'POST');
    await customerPage.getByRole('button', { name: /Continue to secure payment/ }).click();
    const stockRejection = await stockRejectionPromise;
    assert.equal(stockRejection.status(), 422, 'Checkout must revalidate inventory after the quote');
    const stockRejectionBody = await stockRejection.json();
    assert.equal(stockRejectionBody.code, 'item_unavailable');
    await customerPage.getByText('A meal kit in your bag is unavailable for that pickup time. Update your bag or choose another time.', { exact: true }).waitFor({ timeout: 15000 });
    await customerPage.getByRole('button', { name: 'Apply code & review total', exact: true }).waitFor();
    assert.equal((await queryRows('orders', 'id', { user_id: `eq.${customerUserId}` })).length, 0, 'Late stock rejection must not create an order');
    assert.equal(fake.audit.filter(entry => entry.kind === 'checkout_session').length, checkoutSessionsBeforeStockRejection, 'Late stock rejection must not create a Stripe Checkout Session');
    const rejectedInventory = await serviceRequest(`/rest/v1/slot_item_inventory?select=available_qty,reserved_qty&slot_id=eq.${fixture.slotId}&item_id=eq.${fixture.itemId}`);
    assert.deepEqual(rejectedInventory, [{ available_qty: 1, reserved_qty: 0 }], 'A rejected late-stock checkout must not reserve inventory');
    await customerPage.getByRole('button', { name: 'Return to bag and refresh availability', exact: true }).click();
    await customerPage.getByRole('tab', { name: 'Bag, 2 items', exact: true }).waitFor();
    await customerPage.getByRole('button', { name: `Decrease ${mealName} quantity`, exact: true }).waitFor();
    await customerPage.getByRole('button', { name: 'Continue to pickup', exact: true }).click();
    await customerPage.getByText('No pickup time fits this bag', { exact: true }).waitFor({ timeout: 30000 });
    await clickGotIt(customerPage);
    await customerPage.getByRole('tab', { name: 'Bag, 2 items', exact: true }).waitFor();
    await customerPage.getByRole('button', { name: `Decrease ${mealName} quantity`, exact: true }).waitFor();
    await reduceFixtureStock(fixture.availableQty);
    await customerPage.getByRole('button', { name: 'Continue to pickup', exact: true }).click();
    await customerPage.getByText('When would you', { exact: false }).waitFor({ timeout: 30000 });
    await customerPage.getByRole('button', { name: 'Choose pickup time', exact: true }).click();
    await customerPage.getByText('Pick a time that', { exact: false }).waitFor({ timeout: 10000 });
    await customerPage.getByRole('button', { name: 'Continue to details', exact: true }).click();
    await customerPage.getByLabel('Restaurant discount code').waitFor({ timeout: 15000 });
    const refreshedStockQuotePromise = customerPage.waitForResponse(response => new URL(response.url()).pathname === '/v1/checkout/quote' && response.request().method() === 'POST');
    await customerPage.getByRole('button', { name: 'Apply code & review total', exact: true }).click();
    const refreshedStockQuote = await refreshedStockQuotePromise;
    assert.ok(refreshedStockQuote.ok(), `Fresh quote after inventory recovery failed (${refreshedStockQuote.status()})`);
    assert.equal((await refreshedStockQuote.json()).amount_cents, expectedAmountCents, 'The unchanged two-item bag should quote at its exact prior total');
    mark('late stock rejection returned 422, preserved the two-item bag, refreshed availability, and recovered with a fresh quote');

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
    assert.equal(customerUserId, decodeJwt(customerToken).sub, 'OTP user and checkout owner should match');
    mark('customer checkout created with fake Stripe session; checking pending status');
    const statusResponse = await context.request.get(`${apiOrigin}/v1/checkout/${orderId}`, {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    const statusBody = await statusResponse.text();
    assert.ok(statusResponse.ok(), `Pending checkout status GET failed (${statusResponse.status()}): ${statusBody}`);
    assert.equal(JSON.parse(statusBody).status, 'pending');
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
    assert.ok(hiddenResponse.ok);
    assert.deepEqual(await hiddenResponse.json(), [], 'Merchant must not see an unpaid checkout');

    const sessionCountBeforeReplay = fake.audit.filter(entry => entry.kind === 'checkout_session' && entry.orderId === orderId).length;
    const replayResponse = await context.request.post(`${apiOrigin}/v1/checkout`, {
      headers: { authorization: `Bearer ${customerToken}`, 'content-type': 'application/json' },
      data: firstCheckout.requestBody,
    });
    assert.ok(replayResponse.ok(), 'Idempotent retry should resume the same Checkout Session');
    assert.equal((await replayResponse.json()).order_id, orderId);
    assert.equal(fake.audit.filter(entry => entry.kind === 'checkout_session' && entry.orderId === orderId).length, sessionCountBeforeReplay);
    mark('pending status, idempotent replay, and merchant invisibility passed');

    customerPage = await getLocalAppPage(new URL(customerOrigin).port, customerPage, customerOrigin);
    await customerPage.reload({ waitUntil: 'domcontentloaded' });
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
    await customerPage.getByText('Finish secure payment', { exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
    await customerPage.getByRole('tab', { name: 'Bag, 2 items', exact: true }).waitFor({ timeout: 15000 });
    mark('customer cancelled a pending checkout; provider expiry released promo reservation');

    customerPage = await getLocalAppPage(new URL(customerOrigin).port, customerPage, customerOrigin);
    await customerPage.getByRole('tab', { name: 'Bag, 2 items', exact: true }).waitFor({ timeout: 30000 });
    await startPickupFlow(customerPage);
    await customerPage.getByPlaceholder('Email address', { exact: true }).fill(checkoutEmail).catch(() => {});
    const termsAfterRetry = customerPage.getByRole('checkbox', { name: 'Agree to the Consumer Terms and Privacy Policy' });
    if ((await termsAfterRetry.getAttribute('aria-checked')) === 'false') await termsAfterRetry.click();
    await customerPage.getByLabel('Restaurant discount code').fill(promoCode);
    const retryQuotePromise = customerPage.waitForResponse(response => new URL(response.url()).pathname.endsWith('/v1/checkout/quote'), { timeout: 30000 });
    await customerPage.getByRole('button', { name: 'Apply code & review total', exact: true }).click();
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
    const promoDisplay = merchantPage.getByText(`${promoCode} · 10% off`, { exact: true });
    await promoDisplay.scrollIntoViewIfNeeded();
    await promoDisplay.waitFor({ state: 'visible', timeout: 15000 });
    const merchantDocumentWidth = await merchantPage.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(merchantDocumentWidth <= 390, `Restaurant screen must not overflow the 390px viewport (document scrollWidth ${merchantDocumentWidth}px)`);
    await merchantPage.screenshot({ path: `${artifactsDir}/${browserName}-merchant-promo.png` });
    customerPage = await getLocalAppPage(new URL(customerOrigin).port, customerPage, customerOrigin);
    await customerPage.getByRole('button', { name: 'View order progress', exact: true }).waitFor({ timeout: 30000 });
    const successEmail = customerPage.getByText(checkoutEmail, { exact: false });
    await customerPage.screenshot({ path: `${artifactsDir}/${browserName}-customer-success.png`, mask: [successEmail], maskColor: '#FAF6F3' });
    await customerPage.getByRole('button', { name: 'View order progress', exact: true }).click();
    await customerPage.getByRole('tab', { name: 'Orders', exact: true }).click();
    await customerPage.getByText('Paid · awaiting kitchen', { exact: true }).waitFor({ timeout: 30000 });
    await customerPage.getByText(`$${(expectedAmountCents / 100).toFixed(2)}`, { exact: true }).last().waitFor();
    mark('fake Checkout form paid; signed Stripe webhook verified and promoted order to paid');

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
    assert.equal(fake.audit.filter(entry => entry.kind === 'refund' && entry.orderId === paidOrderId).length, 0, 'Dismissed refund confirmation must not contact Stripe for this order');
    await merchantPage.getByRole('button', { name: 'Cancel and refund', exact: true }).click();
    const refundResponsePromise = merchantPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/v1/orders/${paidOrderId}/refund` && response.request().method() === 'POST';
    }, { timeout: 30000 });
    await merchantPage.getByRole('button', { name: 'Confirm refund and cancel', exact: true }).click();
    const refundResponse = await refundResponsePromise;
    if (!refundResponse.ok()) {
      const refundBody = await refundResponse.text().catch(() => '');
      throw new Error(`Mocked local refund endpoint returned ${refundResponse.status()}: ${refundBody.slice(0, 300)}`);
    }
    await waitUntil(async () => (await queryOrder(paidOrderId)).payment_status === 'refunded');
    assert.equal((await queryOrder(paidOrderId)).status, 'cancelled');
    assert.equal(fake.audit.filter(entry => entry.kind === 'refund' && entry.orderId === paidOrderId).length, 1);
    mark('merchant accepted/prepared/readied order; unsafe cancel rejected; refund confirmation guard and fake refund passed');

    customerPage = await getLocalAppPage(new URL(customerOrigin).port, customerPage, customerOrigin);
    await customerPage.getByRole('tab', { name: 'Home', exact: true }).click();
    await customerPage.getByRole('tab', { name: 'Orders', exact: true }).click();
    await customerPage.getByText('Refunded', { exact: true }).waitFor({ timeout: 30000 });
    const customerHistory = await queryRows('orders', 'id,payment_status,status', { id: `eq.${paidOrderId}`, user_id: `eq.${customerUserId}` });
    assert.equal(customerHistory.length, 1);
    await customerPage.screenshot({ path: `${artifactsDir}/${browserName}-customer-refunded.png`, fullPage: true });
    await merchantPage.screenshot({ path: `${artifactsDir}/${browserName}-restaurant-refunded.png`, fullPage: true });

    await customerPage.getByRole('button', { name: 'Open account', exact: true }).click();
    await customerPage.getByRole('button', { name: 'Sign out', exact: true }).click();
    mark('checkout customer signed out before separate profile persistence scenario');
    const customerProfileEmail = `cena-e2e-profile-${runId}-${browserName}@cena.test`;
    await sendAndVerifyAccountOtp(customerPage, customerProfileEmail, '6-digit code', 'Verify and load profile');
    mark('profile OTP verified; checking profile editor visibility');
    await openAccountIfClosed(customerPage);
    mark('profile editor visible after OTP');
    await customerPage.getByPlaceholder('Add your name').fill(`E2E ${browserName} Customer`);
    await customerPage.getByPlaceholder('Add a phone number').fill('5105550147');
    await customerPage.getByRole('button', { name: 'Save profile and privacy choice', exact: true }).click();
    await customerPage.getByText('Your profile and privacy choice are saved.', { exact: true }).waitFor({ timeout: 20000 });
    mark('profile save confirmed before reload');
    mark('reloading customer app for profile persistence');
    await customerPage.reload({ waitUntil: 'domcontentloaded' });
    await openAccountIfClosed(customerPage);
    mark('profile editor reopened after reload');
    await customerPage.getByRole('button', { name: 'Sign out', exact: true }).waitFor({ timeout: 15000 });
    mark('customer remains authenticated after profile reload');
    assert.equal(await customerPage.getByPlaceholder('Add your name').inputValue(), `E2E ${browserName} Customer`);
    const profileRows = await queryRows('profiles', 'display_name,phone', { display_name: `eq.E2E ${browserName} Customer`, phone: 'eq.5105550147' });
    assert.ok(profileRows.length > 0, 'Saved profile should be backed by local Supabase');
    mark('customer OTP profile save and reload persistence passed');

    const checkoutAudit = fake.audit.find(entry => entry.kind === 'checkout_session' && entry.orderId === paidOrderId);
    const webhookAudit = fake.audit.find(entry => entry.kind === 'webhook' && entry.orderId === paidOrderId && entry.status === 200);
    assert.ok(checkoutAudit && webhookAudit);
    assert.deepEqual(errors, [], `Unexpected browser runtime errors: ${errors.join('; ')}`);
    const productWarnings = Array.from(new Set(browserDiagnostics.filter(item => /Unexpected text node|React does not recognize/i.test(item))));
    assert.deepEqual(productWarnings, [], `React Native Web warning diagnostics remain: ${productWarnings.join('; ')}`);
    assert.deepEqual(networkBlocks, [], `Browser attempted non-loopback requests: ${networkBlocks.join(', ')}`);
    report.orderId = paidOrderId;
    report.amountCents = expectedAmountCents;
    report.subtotalCents = expectedSubtotalCents;
    report.discountCents = expectedDiscountCents;
    report.applicationFeeCents = 175;
    report.connectedAccount = checkoutAudit.account;
    report.webhookStatus = webhookAudit.status;
    report.finalStatus = 'refunded';
    report.browserDiagnostics = Array.from(new Set(browserDiagnostics)).slice(0, 8);
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
    throw new Error(`${report.error}; completed stages: ${report.stages.join(' > ')}; API trace: ${apiTrace.slice(-20).join(' | ')}; browser errors: ${Array.from(new Set(errors)).slice(0, 8).join(' | ') || 'none'}; browser diagnostics: ${Array.from(new Set(browserDiagnostics)).slice(0, 8).join(' | ') || 'none'}`);
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
