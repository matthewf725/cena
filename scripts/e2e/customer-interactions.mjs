import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const origin = process.env.CENA_CUSTOMER_URL ?? 'http://127.0.0.1:8081';
const parsedOrigin = new URL(origin);
const loopback = ['127.0.0.1', 'localhost', '[::1]'];
assert.ok(['http:', 'https:'].includes(parsedOrigin.protocol) && loopback.includes(parsedOrigin.hostname), 'Customer UI test only accepts loopback URLs');

const engine = process.env.CENA_CUSTOMER_BROWSER ?? 'chromium';
const browserType = { chromium, webkit }[engine];
assert.ok(browserType, 'Choose chromium or webkit for CENA_CUSTOMER_BROWSER');
const browser = await browserType.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', deviceScaleFactor: 2 });
const page = await context.newPage();
const blocked = [];
const restaurantTimezones = new Map();
let forceTomorrowPickup = false;
let shiftedPickupSlots = 0;
let pickupTimezoneUsed = null;

function rememberTimezones(value, depth = 0) {
  if (depth > 7 || value == null) return;
  if (Array.isArray(value)) { for (const entry of value) rememberTimezones(entry, depth + 1); return; }
  if (typeof value !== 'object') return;
  if (typeof value.id === 'string' && typeof value.timezone === 'string') restaurantTimezones.set(value.id, value.timezone);
  for (const child of Object.values(value)) rememberTimezones(child, depth + 1);
}

function tomorrowAtServiceTime(iso, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(iso)).map(({ type, value }) => [type, value]));
  const today = Object.fromEntries(formatter.formatToParts(new Date()).map(({ type, value }) => [type, value]));
  const tomorrow = new Date(Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day) + 1));
  const desired = Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const rendered = Object.fromEntries(formatter.formatToParts(new Date(desired)).map(({ type, value }) => [type, value]));
  const renderedAsUtc = Date.UTC(Number(rendered.year), Number(rendered.month) - 1, Number(rendered.day), Number(rendered.hour), Number(rendered.minute), Number(rendered.second));
  return new Date(desired + desired - renderedAsUtc).toISOString();
}

await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (['http:', 'https:'].includes(url.protocol) && !loopback.includes(url.hostname)) {
    blocked.push(url.origin);
    return route.abort('blockedbyclient');
  }
  if (forceTomorrowPickup && url.pathname.endsWith('/pickup_slots')) {
    const response = await route.fetch({ maxRedirects: 0, timeout: 10000 });
    const rows = await response.json();
    if (Array.isArray(rows) && rows.length > 0) {
      const restaurantId = (url.searchParams.get('restaurant_id') ?? '').replace(/^eq\./, '');
      const timezone = restaurantTimezones.get(restaurantId) ?? 'America/Los_Angeles';
      pickupTimezoneUsed = timezone;
      const shifted = rows.map(slot => {
        const startsAt = tomorrowAtServiceTime(slot.starts_at, timezone);
        const duration = Math.max(60_000, Date.parse(slot.ends_at) - Date.parse(slot.starts_at));
        const cutoffLead = Math.max(60_000, Date.parse(slot.starts_at) - Date.parse(slot.cutoff_at));
        return {
          ...slot,
          starts_at: startsAt,
          ends_at: new Date(Date.parse(startsAt) + duration).toISOString(),
          cutoff_at: new Date(Date.parse(startsAt) - cutoffLead).toISOString(),
        };
      });
      shiftedPickupSlots += shifted.length;
      return route.fulfill({ response, json: shifted });
    }
    return route.fulfill({ response, json: rows });
  }
  if (['http:', 'https:'].includes(url.protocol) && (/\/v1\/discovery$/.test(url.pathname) || /\/rpc\/discover_pickup_feed$/.test(url.pathname))) {
    const response = await route.fetch({ maxRedirects: 0, timeout: 10000 });
    const body = await response.json();
    rememberTimezones(body);
    return route.fulfill({ response, json: body });
  }
  return route.continue();
});

try {
  const response = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
  assert.ok(response?.ok(), `Preview returned ${response?.status() ?? 'no response'}`);
  await page.getByRole('textbox', { name: 'Search restaurants and meal kits' }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /Change pickup area/ }).waitFor();
  const mediaReduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  assert.equal(mediaReduced, true, 'Browser reduced-motion preference should be honored');

  await page.getByText('Recents', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByText('Recent meal kits', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByText('Near you', { exact: true }).waitFor({ timeout: 30000 });
  const headings = await page.getByText(/^(Recents|Recent meal kits|Near you)$/).allTextContents();
  const recentsIndex = headings.indexOf('Recents');
  const mealIndex = headings.indexOf('Recent meal kits');
  const nearbyIndex = headings.indexOf('Near you');
  assert.ok(recentsIndex >= 0, `Recents heading should render (headings: ${JSON.stringify(headings)})`);
  assert.ok(mealIndex > recentsIndex, `Recent meal kits should follow Recents (headings: ${JSON.stringify(headings)})`);
  assert.ok(nearbyIndex > mealIndex, `Near you should follow Recent meal kits (headings: ${JSON.stringify(headings)})`);
  const hasRecentKitchen = await page.getByRole('button', { name: /^View .+ menu$/ }).count() > 0;

  const timer = page.getByRole('timer');
  let countdown = 'not rendered (no currently eligible same-day pickup slot)';
  if (await timer.count()) {
    const before = (await timer.first().innerText()).trim();
    assert.match(before, /^\d{2,}:\d{2}:\d{2}$/);
    assert.ok(await page.getByText('Order cutoff for pickup today', { exact: true }).count());
    await page.waitForTimeout(1250);
    const after = (await timer.first().innerText()).trim();
    assert.notEqual(after, before, `Live pickup countdown stayed at ${before}`);
    countdown = `${before} -> ${after}`;
  }

  const layout = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    search: (() => { const r = document.querySelector('input[aria-label="Search restaurants and meal kits"]')?.getBoundingClientRect(); return r && { left: r.left, right: r.right, width: r.width }; })(),
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }));
  assert.ok(layout.document <= layout.viewport + 1, `Horizontal overflow: ${JSON.stringify(layout)}`);
  assert.ok(layout.search && layout.search.left >= 0 && layout.search.right <= layout.viewport, `Search field overflows viewport: ${JSON.stringify(layout)}`);

  // Add one kit, then force the next menu response to expose tomorrow-only windows.
  // This is a loopback response override; it performs no order, auth, or database write.
  const firstKitchen = page.getByRole('button', { name: /^View .+ menu$/ }).first();
  const firstKitchenLabel = await firstKitchen.getAttribute('aria-label');
  assert.ok(firstKitchenLabel, 'First kitchen must be present in discovery');
  await firstKitchen.click();
  await page.getByText('Finish-at-home favorites', { exact: true }).waitFor({ timeout: 15000 });
  const addButton = page.getByRole('button', { name: /^Add .+ to bag$/ }).first();
  await addButton.waitFor({ timeout: 15000 });
  const firstMealName = (await addButton.getAttribute('aria-label')).replace(/^Add | to bag$/g, '');
  await addButton.click();
  await page.getByRole('button', { name: 'View bag', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  const kitchenLabels = await page.getByRole('button', { name: /^View .+ menu$/ }).evaluateAll(cards => cards.map(card => card.getAttribute('aria-label')));
  const alternateLabel = kitchenLabels.find(label => label && label !== firstKitchenLabel);
  assert.ok(alternateLabel, 'Two stocked restaurants are needed to test the bag conflict');
  await page.getByRole('button', { name: alternateLabel, exact: true }).first().click();
  const otherAdd = page.getByRole('button', { name: /^Add .+ to bag$/ }).first();
  await otherAdd.click({ timeout: 15000 });
  await page.getByText('One kitchen at a time', { exact: true }).waitFor({ timeout: 5000 });
  await page.getByText('Got it', { exact: true }).click();

  // Reopen the original kitchen, then enter the saved bag. The fixture shifts all
  // returned pickup slots to the next calendar day in that restaurant's timezone.
  if (await page.getByRole('button', { name: 'Go back' }).count()) await page.getByRole('button', { name: 'Go back' }).click();
  await page.getByRole('tab', { name: /Bag, 1 item/ }).click();
  await page.getByText(firstMealName, { exact: true }).waitFor();
  forceTomorrowPickup = true;
  await page.getByRole('button', { name: 'Continue to pickup', exact: true }).click();
  await page.getByText('When would you', { exact: false }).waitFor({ timeout: 30000 });
  assert.ok(shiftedPickupSlots > 0, 'The loopback fixture should have shifted at least one available slot');
  const radioStates = await page.getByRole('radio').evaluateAll(radios => radios.map(radio => ({
    label: radio.getAttribute('aria-label'), checked: radio.getAttribute('aria-checked'),
  })));
  assert.ok(radioStates.some(radio => radio.checked === 'true'), `Pickup date should have a selected radio: ${JSON.stringify(radioStates)}`);
  const selectedRadio = radioStates.find(radio => radio.checked === 'true');
  const expectedTomorrow = new Intl.DateTimeFormat('en-US', {
    timeZone: pickupTimezoneUsed ?? 'America/Los_Angeles', weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date(Date.now() + 86400000));
  assert.ok(selectedRadio.label?.startsWith(expectedTomorrow), `Expected tomorrow (${expectedTomorrow}) selected in ${pickupTimezoneUsed}: ${JSON.stringify(radioStates)}`);
  await page.getByRole('button', { name: 'Choose pickup time', exact: true }).click();
  await page.getByRole('radio').first().waitFor();
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await page.getByRole('button', { name: 'Go back', exact: true }).click();

  await page.getByRole('button', { name: /Change pickup area/ }).click();
  await page.getByRole('heading', { name: 'Pickup area' }).waitFor();
  await page.getByRole('textbox', { name: 'Street address, city or ZIP code' }).waitFor();
  await page.getByRole('button', { name: 'Close pickup area' }).click();
  await page.getByRole('heading', { name: 'Pickup area' }).waitFor({ state: 'detached' });
  assert.deepEqual(blocked, [], `Unexpected non-loopback requests: ${blocked.join(', ')}`);

  console.log(JSON.stringify({
    result: 'PASS', engine, viewport: '390x844 CSS px, DPR 2', reducedMotion: mediaReduced,
    noHorizontalOverflow: layout.document <= layout.viewport + 1,
    recentSectionOrder: 'Recents -> Recent meal kits -> Near you',
    recentKitchenPresent: hasRecentKitchen,
    countdown,
    bagConflict: 'second kitchen add rejected while first kitchen item remains in bag',
    nextDayPickup: { selected: selectedRadio.label, timezone: pickupTimezoneUsed, fixtureSlotsShifted: shiftedPickupSlots },
    pickupAreaOpenAndDismiss: 'PASS', nonLoopbackRequests: blocked,
  }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
