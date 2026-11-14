import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.CENA_CUSTOMER_URL ?? 'http://127.0.0.1:8081';
const parsedOrigin = new URL(origin);
const loopback = ['127.0.0.1', 'localhost', '[::1]'];
assert.ok(['http:', 'https:'].includes(parsedOrigin.protocol) && loopback.includes(parsedOrigin.hostname), 'Customer UI test only accepts loopback URLs');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', deviceScaleFactor: 2 });
const page = await context.newPage();
const blocked = [];
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (['http:', 'https:'].includes(url.protocol) && !loopback.includes(url.hostname)) {
    blocked.push(url.origin);
    return route.abort('blockedbyclient');
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

  await page.getByRole('button', { name: /Change pickup area/ }).click();
  await page.getByRole('heading', { name: 'Pickup area' }).waitFor();
  await page.getByRole('textbox', { name: 'Street address, city or ZIP code' }).waitFor();
  await page.getByRole('button', { name: 'Close pickup area' }).click();
  await page.getByRole('heading', { name: 'Pickup area' }).waitFor({ state: 'detached' });
  assert.deepEqual(blocked, [], `Unexpected non-loopback requests: ${blocked.join(', ')}`);

  console.log(JSON.stringify({
    result: 'PASS', viewport: '390x844 CSS px, DPR 2', reducedMotion: mediaReduced,
    noHorizontalOverflow: layout.document <= layout.viewport + 1,
    recentSectionOrder: 'Recents -> Recent meal kits -> Near you',
    recentKitchenPresent: hasRecentKitchen,
    countdown,
    pickupAreaOpenAndDismiss: 'PASS', nonLoopbackRequests: blocked,
  }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
