import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.CENA_CUSTOMER_URL ?? 'http://127.0.0.1:8081';
const base = new URL(origin);
const loopback = ['127.0.0.1', 'localhost', '[::1]'];
assert.ok(['http:', 'https:'].includes(base.protocol) && loopback.includes(base.hostname), 'Only loopback previews are allowed');

const artifacts = resolve('artifacts/e2e/customer-responsive');
await mkdir(artifacts, { recursive: true });
const sizes = [
  { name: 'narrow-short', width: 320, height: 568 },
  { name: 'compact-phone', width: 375, height: 667 },
  { name: 'landscape-phone', width: 844, height: 390 },
];
const browser = await chromium.launch({ headless: true });
const results = [];

async function openAndAddMeal(page) {
  const kitchen = page.getByRole('button', { name: /^View .+ menu$/ }).first();
  assert.ok(await kitchen.count(), 'A kitchen menu should be available');
  await kitchen.click();
  await page.getByText('Finish-at-home favorites', { exact: true }).waitFor({ timeout: 20000 });
  const addButton = page.getByRole('button', { name: /^Add .+ to bag$/ }).first();
  await addButton.waitFor({ timeout: 15000 });
  await addButton.waitFor({ state: 'visible' });
  await page.waitForFunction(button => !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true', await addButton.elementHandle(), { timeout: 15000 });
  await addButton.click();
  await page.getByRole('button', { name: 'View bag', exact: true }).waitFor();
}

async function verifyNoOverflow(page, viewport, step) {
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(metrics.document <= viewport.width + 1 && metrics.body <= viewport.width + 1,
    `${step}: horizontal overflow at ${viewport.width}x${viewport.height}: ${JSON.stringify(metrics)}`);
  return metrics;
}

try {
  for (const viewport of sizes) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    const blocked = [];
    const pageErrors = [];
    await page.addInitScript(() => {
      window.__cenaMotionSamples = [];
      const record = element => {
        if (!(element instanceof HTMLElement)) return;
        const style = element.style;
        if (!style.opacity && !style.transform) return;
        window.__cenaMotionSamples.push({ opacity: style.opacity, transform: style.transform, at: performance.now() });
      };
      new MutationObserver(records => { for (const recordEntry of records) record(recordEntry.target); })
        .observe(document, { subtree: true, attributes: true, attributeFilter: ['style'] });
    });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && !loopback.includes(url.hostname)) {
        blocked.push(url.origin);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    page.on('pageerror', error => pageErrors.push(error.message));

    const response = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
    assert.ok(response?.ok(), `${viewport.name}: preview HTTP ${response?.status() ?? 'no response'}`);
    await page.getByRole('textbox', { name: 'Search restaurants and meal kits' }).waitFor({ timeout: 30000 });
    await page.getByText('Recents', { exact: true }).waitFor({ timeout: 30000 });
    await verifyNoOverflow(page, viewport, 'discovery');
    const searchBox = await page.getByRole('textbox', { name: 'Search restaurants and meal kits' }).boundingBox();
    assert.ok(searchBox && searchBox.x >= 0 && searchBox.x + searchBox.width <= viewport.width + 1,
      `${viewport.name}: search input clipped: ${JSON.stringify(searchBox)}`);
    await page.screenshot({ path: `${artifacts}/${viewport.name}-discovery.png` });

    await openAndAddMeal(page);
    await page.getByRole('button', { name: 'View bag' }).click();
    await page.getByRole('button', { name: 'Continue to pickup', exact: true }).click();
    await page.getByText('When would you', { exact: false }).waitFor({ timeout: 30000 });
    await page.waitForTimeout(250);
    await verifyNoOverflow(page, viewport, 'pickup date');
    const dateButton = page.getByRole('button', { name: 'Choose pickup time', exact: true });
    let dateBounds = await dateButton.boundingBox();
    if (!dateBounds || dateBounds.y + dateBounds.height > viewport.height) {
      await dateButton.scrollIntoViewIfNeeded();
      dateBounds = await dateButton.boundingBox();
    }
    assert.ok(dateBounds && dateBounds.x >= 0 && dateBounds.x + dateBounds.width <= viewport.width + 1
      && dateBounds.y >= 0 && dateBounds.y + dateBounds.height <= viewport.height + 1,
    `${viewport.name}: pickup date action clipped: ${JSON.stringify(dateBounds)}`);
    await page.screenshot({ path: `${artifacts}/${viewport.name}-pickup-date.png` });

    await dateButton.click();
    await page.getByText('Pick a time that', { exact: false }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(250);
    await verifyNoOverflow(page, viewport, 'pickup time');
    const detailsButton = page.getByRole('button', { name: 'Continue to details', exact: true });
    await detailsButton.scrollIntoViewIfNeeded();
    const detailsBounds = await detailsButton.boundingBox();
    assert.ok(detailsBounds && detailsBounds.x >= 0 && detailsBounds.x + detailsBounds.width <= viewport.width + 1
      && detailsBounds.y >= 0 && detailsBounds.y + detailsBounds.height <= viewport.height + 1,
    `${viewport.name}: continue-to-details action clipped: ${JSON.stringify(detailsBounds)}`);
    await page.screenshot({ path: `${artifacts}/${viewport.name}-pickup-time.png` });

    await detailsButton.click();
    await page.getByRole('textbox', { name: 'Email address' }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(250);
    await verifyNoOverflow(page, viewport, 'checkout details');
    const emailBox = await page.getByRole('textbox', { name: 'Email address' }).boundingBox();
    assert.ok(emailBox && emailBox.x >= 0 && emailBox.x + emailBox.width <= viewport.width + 1,
      `${viewport.name}: email input clipped: ${JSON.stringify(emailBox)}`);
    const codeButton = page.getByRole('button', { name: 'Email me a sign-in code', exact: true });
    await codeButton.scrollIntoViewIfNeeded();
    const codeBounds = await codeButton.boundingBox();
    assert.ok(codeBounds && codeBounds.x >= 0 && codeBounds.x + codeBounds.width <= viewport.width + 1
      && codeBounds.y >= 0 && codeBounds.y + codeBounds.height <= viewport.height + 1,
    `${viewport.name}: checkout action clipped: ${JSON.stringify(codeBounds)}`);
    await page.screenshot({ path: `${artifacts}/${viewport.name}-checkout.png` });
    assert.deepEqual(blocked, [], `${viewport.name}: attempted non-loopback requests`);
    assert.deepEqual(pageErrors, [], `${viewport.name}: browser runtime errors`);
    results.push({ viewport: viewport.name, size: `${viewport.width}x${viewport.height}`, discovery: 'pass', pickupDate: 'pass', pickupTime: 'pass', checkout: 'pass', externalRequests: blocked, errors: pageErrors });
    await context.close();
  }

  // Verify animation actually interpolates when motion is allowed, then settles.
  const motionContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });
  const motionPage = await motionContext.newPage();
  await motionPage.addInitScript(() => {
    window.__cenaMotionSamples = [];
    const observer = new MutationObserver(records => {
      for (const entry of records) {
        const element = entry.target;
        if (!(element instanceof HTMLElement)) continue;
        if (element.style.opacity || element.style.transform) window.__cenaMotionSamples.push({ opacity: element.style.opacity, transform: element.style.transform });
      }
    });
    observer.observe(document, { subtree: true, attributes: true, attributeFilter: ['style'] });
  });
  await motionContext.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && !loopback.includes(url.hostname)) return route.abort('blockedbyclient');
    return route.continue();
  });
  await motionPage.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await motionPage.getByText('Recents', { exact: true }).waitFor({ timeout: 30000 });
  await motionPage.getByRole('button', { name: /^View .+ menu$/ }).first().click();
  await motionPage.getByText('Finish-at-home favorites', { exact: true }).waitFor({ timeout: 15000 });
  await motionPage.waitForTimeout(45);
  const motionSamples = await motionPage.evaluate(() => window.__cenaMotionSamples);
  const hasIntermediate = motionSamples.some(sample => {
    const opacity = Number(sample.opacity);
    const transform = sample.transform ?? '';
    return Number.isFinite(opacity) && opacity > 0 && opacity < 1 || /translateY\((?:[1-7](?:\.\d+)?|0\.\d+)px\)/.test(transform);
  });
  await motionPage.waitForTimeout(250);
  assert.ok(hasIntermediate, `Expected an active entrance interpolation; saw ${JSON.stringify(motionSamples.slice(-8))}`);
  const settledSamples = await motionPage.evaluate(() => window.__cenaMotionSamples.slice(-10));
  assert.ok(settledSamples.some(sample => sample.opacity === '1' || sample.transform?.includes('translateY(0px)')),
    `Expected entrance to settle; saw ${JSON.stringify(settledSamples)}`);
  await motionContext.close();

  const reducedContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const reducedPage = await reducedContext.newPage();
  await reducedPage.addInitScript(() => {
    window.__cenaMotionSamples = [];
    const observer = new MutationObserver(records => {
      for (const entry of records) {
        const element = entry.target;
        if (!(element instanceof HTMLElement)) continue;
        if (element.style.opacity || element.style.transform) window.__cenaMotionSamples.push({ opacity: element.style.opacity, transform: element.style.transform });
      }
    });
    observer.observe(document, { subtree: true, attributes: true, attributeFilter: ['style'] });
  });
  await reducedContext.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && !loopback.includes(url.hostname)) return route.abort('blockedbyclient');
    return route.continue();
  });
  await reducedPage.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await reducedPage.getByText('Recents', { exact: true }).waitFor({ timeout: 30000 });
  await reducedPage.getByRole('button', { name: /^View .+ menu$/ }).first().click();
  await reducedPage.getByText('Finish-at-home favorites', { exact: true }).waitFor({ timeout: 15000 });
  await reducedPage.waitForTimeout(60);
  const reducedState = await reducedPage.evaluate(() => ({
    matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
    samples: window.__cenaMotionSamples,
  }));
  assert.equal(reducedState.matches, true);
  const reducedAnimated = reducedState.samples.some(sample => {
    const opacity = Number(sample.opacity);
    return Number.isFinite(opacity) && opacity < 1 || /translateY\([1-9]\d*(?:\.\d+)?px\)/.test(sample.transform ?? '');
  });
  assert.equal(reducedAnimated, false, `Reduced motion should skip entrance interpolation: ${JSON.stringify(reducedState.samples.slice(-8))}`);
  await reducedContext.close();

  console.log(JSON.stringify({ result: 'PASS', responsive: results, motion: 'interpolates and settles with no-preference; entrance skipped with reduce', screenshots: artifacts }, null, 2));
} finally {
  await browser.close();
}
