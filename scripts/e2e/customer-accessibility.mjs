import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.CENA_CUSTOMER_URL ?? 'http://127.0.0.1:8081';
const base = new URL(origin);
const loopback = ['127.0.0.1', 'localhost', '[::1]'];
assert.ok(['http:', 'https:'].includes(base.protocol) && loopback.includes(base.hostname), 'Only loopback previews are allowed');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 375, height: 667 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const externalRequests = [];
const unexpectedLocalRequests = [];
const reactWarnings = [];
const pageErrors = [];
let geocodeStarted = false;
let geocodeAborted = false;
let geocodeResolved = false;
let releaseGeocode;
const geocodeRequestStarted = new Promise(resolve => { releaseGeocode = resolve; });
const restaurant = {
  id: '11111111-1111-4111-8111-111111111111', slug: 'keyboard-test-kitchen', name: 'Keyboard Test Kitchen',
  cuisine: 'Italian', image_key: 'mediterranean', address: '100 Test Street, Oakland, CA', timezone: 'America/Los_Angeles',
  curbside_enabled: true, latitude: 37.8044, longitude: -122.2712, distance_miles: 1.2,
};
const item = {
  id: '22222222-2222-4222-8222-222222222222', name: 'Keyboard Test Lasagna', description: 'Local test meal kit',
  price_cents: 1600, prepared_meal_total_cents: 1850, image_key: 'lasagna', equipment: ['Oven'],
  published_steps: ['Heat until warm'], published_at: new Date().toISOString(),
};
const slotId = '33333333-3333-4333-8333-333333333333';
const startsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const endsAt = new Date(Date.parse(startsAt) + 30 * 60 * 1000).toISOString();
const cutoffAt = new Date(Date.parse(startsAt) - 60 * 60 * 1000).toISOString();
const corsHeaders = {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Headers': 'apikey,authorization,content-type,x-client-info',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === origin) return route.continue();
  if (url.origin === 'http://127.0.0.1:8080' && url.pathname === '/v1/discovery') {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: corsHeaders });
    const discoveryRestaurant = { ...restaurant, next_slot: { id: slotId, starts_at: startsAt, ends_at: endsAt, cutoff_at: cutoffAt } };
    const discovery = {
      recent: [], explore: [{ restaurant: discoveryRestaurant, meal: item }], nearby: [discoveryRestaurant],
      categories: [{ name: 'Italian', restaurants: [discoveryRestaurant] }], next_cursor: null,
    };
    return route.fulfill({ status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(discovery) });
  }
  if (url.origin === 'http://127.0.0.1:8080' && url.pathname === '/v1/geocode') {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: corsHeaders });
    geocodeStarted = true;releaseGeocode();
    await new Promise(resolve => setTimeout(resolve, 700));
    try {
      await route.fulfill({ status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({
        label: '100 Test Street, Oakland, CA', latitude: 37.8044, longitude: -122.2712,
      }) });
      geocodeResolved=true;
      return;
    } catch { geocodeAborted=true;return; }
  }
  if (url.origin === 'http://127.0.0.1:54323' && url.pathname.startsWith('/rest/v1/')) {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: corsHeaders });
    const table = url.pathname.split('/').at(-1);
    const rows = table === 'restaurants' ? [restaurant]
      : table === 'catalog_items' ? [item]
        : table === 'pickup_slots' ? [{ id: slotId, restaurant_id: restaurant.id, starts_at: startsAt, ends_at: endsAt, cutoff_at: cutoffAt, capacity: 10, reserved_count: 0 }]
          : table === 'slot_item_inventory' ? [{ slot_id: slotId, item_id: item.id, available_qty: 10, reserved_qty: 0 }]
            : [];
    return route.fulfill({ status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(rows) });
  }
  if (['http:', 'https:'].includes(url.protocol) && !loopback.includes(url.hostname)) {
    externalRequests.push(url.origin);
    return route.abort('blockedbyclient');
  }
  if (['http:', 'https:'].includes(url.protocol)) {
    unexpectedLocalRequests.push(`${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  }
  return route.continue();
});
page.on('pageerror', error => pageErrors.push(error.message));
page.on('console', message => {
  if (message.type() === 'warning' && /accessibilityElementsHidden|importantForAccessibility/.test(message.text())) reactWarnings.push(message.text());
});
await page.addInitScript(() => {
  window.__cenaA11yMotionSamples = [];
  new MutationObserver(records => {
    for (const entry of records) {
      const element = entry.target;
      if (element instanceof HTMLElement && (element.style.opacity || element.style.transform)) {
        window.__cenaA11yMotionSamples.push({ opacity: element.style.opacity, transform: element.style.transform });
      }
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['style'] });
});

async function activateWithKeyboard(locator, key = 'Enter') {
  await locator.focus();
  assert.equal(await locator.evaluate(element => element === document.activeElement), true, 'Control should receive keyboard focus');
  await page.keyboard.press(key);
}

try {
  const response = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
  assert.ok(response?.ok(), `Preview HTTP ${response?.status() ?? 'no response'}`);
  await page.getByRole('textbox', { name: 'Search restaurants' }).waitFor({ timeout: 30000 });
  await page.getByText('Recents', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);

  const pickupArea = page.getByRole('button', { name: /^Change pickup area/ });
  await activateWithKeyboard(pickupArea);
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  const address = dialog.getByRole('textbox', { name: 'Street address, city or ZIP code' });
  await address.waitFor();
  assert.equal(await address.evaluate(element => element === document.activeElement), true, 'Opening location picker should focus its address input');
  const focusables = dialog.locator('input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])');
  const focusableCount = await focusables.count();
  assert.ok(focusableCount >= 3, `Expected address, close, and location actions in dialog; found ${focusableCount}`);
  await focusables.first().focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await focusables.nth(focusableCount - 1).evaluate(element => element === document.activeElement), true, 'Shift+Tab from dialog start should wrap to its last control');
  await page.keyboard.press('Tab');
  assert.equal(await focusables.first().evaluate(element => element === document.activeElement), true,
    `Tab from dialog end should wrap to its first control (focusables=${await focusables.evaluateAll(nodes=>nodes.map(node=>node.outerHTML.slice(0,160)))}, active=${await page.evaluate(()=>document.activeElement?.outerHTML?.slice(0,160))})`);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await pickupArea.evaluate(element => element === document.activeElement), true, 'Closing location picker should restore focus to its opener');
  await activateWithKeyboard(pickupArea);
  await page.getByRole('dialog').waitFor();
  await activateWithKeyboard(page.getByRole('button', { name: 'Close pickup area', exact: true }));
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await pickupArea.evaluate(element => element === document.activeElement), true, 'Close button should restore focus to the pickup-area trigger');
  await activateWithKeyboard(pickupArea);
  await page.getByRole('dialog').waitFor();
  await page.getByRole('textbox', { name: 'Street address, city or ZIP code' }).fill('100 Test Street, Oakland, CA');
  await page.getByRole('button', { name: 'Use this address', exact: true }).click();
  await geocodeRequestStarted;
  assert.equal(geocodeStarted, true, 'Address lookup should reach the loopback fixture');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 });
  await page.waitForTimeout(800);
  assert.ok(geocodeAborted||geocodeResolved,'The delayed geocode fixture should either be canceled or resolve after dismissal');
  assert.equal(await pickupArea.getAttribute('aria-label'), 'Change pickup area, From San Francisco', 'A lookup resolving after dismissal must not change the pickup area');

  const kitchen = page.getByRole('button', { name: /^View .+ menu$/ }).first();
  await activateWithKeyboard(kitchen);
  await page.getByText('Finish-at-home favorites', { exact: true }).waitFor({ timeout: 15000 });
  const add = page.getByRole('button', { name: /^Add .+ to bag$/ }).first();
  await activateWithKeyboard(add, 'Space');
  const viewBag = page.getByRole('button', { name: 'View bag', exact: true });
  await viewBag.waitFor();
  await activateWithKeyboard(viewBag);
  const increase = page.getByRole('button', { name: /^Increase .+ quantity$/ }).first();
  await activateWithKeyboard(increase, 'Space');
  await page.getByText('2', { exact: true }).first().waitFor({ timeout: 3000 });
  const continuePickup = page.getByRole('button', { name: 'Continue to pickup', exact: true });
  await activateWithKeyboard(continuePickup);
  await page.getByText('When would you', { exact: false }).waitFor({ timeout: 20000 });

  const dates = page.getByRole('radio');
  const dateCount = await dates.count();
  assert.ok(dateCount > 0, 'Pickup date choices should be keyboard accessible radios');
  const dateTarget = dates.nth(dateCount > 1 ? 1 : 0);
  await activateWithKeyboard(dateTarget, 'Space');
  assert.equal(await dateTarget.getAttribute('aria-checked'), 'true', 'Space should select a pickup date');
  const chooseTime = page.getByRole('button', { name: 'Choose pickup time', exact: true });
  await activateWithKeyboard(chooseTime);
  await page.getByText('Pick a time that', { exact: false }).waitFor({ timeout: 5000 });

  const times = page.getByRole('radio');
  const timeCount = await times.count();
  assert.ok(timeCount > 0, 'Pickup time choices should be keyboard accessible radios');
  let selectedTime = page.getByRole('radio', { checked: true }).first();
  const selectedTimeLabel = await selectedTime.getAttribute('aria-label');
  let timeTarget = times.nth(0);
  if ((await times.nth(0).getAttribute('aria-label')) === selectedTimeLabel && timeCount > 1) timeTarget = times.nth(1);
  await activateWithKeyboard(timeTarget, 'Space');
  assert.equal(await timeTarget.getAttribute('aria-checked'), 'true', 'Space should select a pickup time');
  const continueDetails = page.getByRole('button', { name: 'Continue to details', exact: true });
  await activateWithKeyboard(continueDetails);
  const email = page.getByRole('textbox', { name: 'Email address' });
  await email.waitFor();
  await email.focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('textbox', { name: 'Mobile number, optional' }).evaluate(element => element === document.activeElement), true,
    'Tab from email should reach optional phone field');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await email.evaluate(element => element === document.activeElement), true, 'Shift+Tab should return to email');
  await page.waitForTimeout(80);
  const motionSamples = await page.evaluate(() => window.__cenaA11yMotionSamples);
  const reducedMotionInterpolated = motionSamples.some(sample => {
    const opacity = Number(sample.opacity);
    return (Number.isFinite(opacity) && opacity > 0 && opacity < 1)
      || /translateY\((?!0(?:\.0+)?px)[^)]+px\)/.test(sample.transform ?? '');
  });
  assert.equal(reducedMotionInterpolated, false, 'Reduced-motion preference should suppress entrance interpolation');

  assert.deepEqual(externalRequests, [], 'Preview should make no non-loopback requests');
  assert.deepEqual(unexpectedLocalRequests, [], 'Preview should not contact unmocked local services');
  assert.deepEqual(pageErrors, [], 'Preview should have no JavaScript errors');
  assert.deepEqual(reactWarnings, [], 'Native-only accessibility props should not leak to React DOM');
  console.log(JSON.stringify({ result: 'PASS', viewport: '375x667', checks: [
    'location modal initial focus, Tab wrapping, Escape/close focus restoration, and dismissal during in-flight geocoding',
    'keyboard activation for kitchen, add-to-bag, bag navigation, and quantity stepper',
    'keyboard date/time radio selection and checkout field tab order',
    'reduced-motion preference; no external requests, JavaScript errors, or native-prop console warnings',
  ] }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
