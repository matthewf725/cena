import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthTimeoutFetch } from '../apps/customer/lib/auth-timeout-fetch.ts';

const neverResolves = (_input, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
});

test('aborts a stalled OTP send at the configured deadline', async () => {
  const timedFetch = createAuthTimeoutFetch(neverResolves, 10);
  await assert.rejects(timedFetch('https://example.test/auth/v1/otp', { method: 'POST' }), { name: 'AbortError' });
});

test('aborts a stalled OTP verification at the configured deadline', async () => {
  const timedFetch = createAuthTimeoutFetch(neverResolves, 10);
  await assert.rejects(timedFetch('https://example.test/auth/v1/verify', { method: 'POST' }), { name: 'AbortError' });
});

test('keeps the abort deadline active while the OTP response body is stalled', async () => {
  const bodyFetch = async (_input, init) => {
    const stream = new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      },
    });
    return new Response(stream);
  };
  const timedFetch = createAuthTimeoutFetch(bodyFetch, 10);
  const response = await timedFetch('https://example.test/auth/v1/verify', { method: 'POST' });
  await assert.rejects(response.text(), { name: 'AbortError' });
});

test('keeps non-OTP Supabase calls on the original fetch path', async () => {
  let observedInit;
  const originalFetch = async (_input, init) => {
    observedInit = init;
    return new Response('ok');
  };
  const init = { method: 'GET' };
  const response = await createAuthTimeoutFetch(originalFetch, 1)('https://example.test/rest/v1/catalog_items', init);
  assert.equal(await response.text(), 'ok');
  assert.equal(observedInit, init);
});

test('preserves caller cancellation for OTP requests', async () => {
  const caller = new AbortController();
  const timedFetch = createAuthTimeoutFetch(neverResolves, 5_000);
  const request = timedFetch('https://example.test/auth/v1/verify', { signal: caller.signal });
  caller.abort();
  await assert.rejects(request, { name: 'AbortError' });
});
