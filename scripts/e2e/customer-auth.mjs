import assert from 'node:assert/strict';

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Sign in a standalone customer preview only with an explicit loopback fixture. */
export async function signInCustomerFixture(page) {
  const email = process.env.CENA_E2E_CUSTOMER_EMAIL;
  const password = process.env.CENA_E2E_CUSTOMER_PASSWORD;
  const configuredUrl = process.env.CENA_E2E_SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  assert.ok(email && password, 'Set CENA_E2E_CUSTOMER_EMAIL and CENA_E2E_CUSTOMER_PASSWORD to run signed-in browse scenarios.');
  assert.ok(configuredUrl, 'Set CENA_E2E_SUPABASE_URL to the loopback Supabase fixture; these scripts never sign in to hosted auth.');
  const backend = new URL(configuredUrl);
  assert.ok(['http:', 'https:'].includes(backend.protocol) && loopback.has(backend.hostname),
    'Customer E2E auth must use a loopback Supabase URL.');

  await page.getByRole('heading', { name: 'Cena', exact: true }).waitFor({ timeout: 30000 });
  const search = page.getByRole('textbox', { name: 'Search restaurants' });
  assert.equal(await search.count(), 0, 'Signed-out visitors must not see restaurant search or discovery.');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  await page.getByPlaceholder('Email', { exact: true }).fill(email);
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  const authResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    const sameLoopback = url.hostname === backend.hostname || loopback.has(url.hostname) && loopback.has(backend.hostname);
    return sameLoopback && url.port === backend.port && url.pathname.endsWith('/auth/v1/token') && response.request().method() === 'POST';
  }, { timeout: 30000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await authResponse;
  assert.ok(response.ok(), `Loopback fixture sign-in failed (${response.status()}).`);
  await search.waitFor({ timeout: 30000 });
}
