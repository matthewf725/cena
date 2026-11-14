import assert from 'node:assert/strict';
import test from 'node:test';
import { createManifestWorker } from './ios-preview-manifest-worker.mjs';

const route = 'https://demo.example/customer/ios-preview/manifest.json';
const customerOrigin = 'https://cena-calpoly-customer.trustworthybasket2.chatgpt.site';
const sample = sdkVersion => ({
  id: '91834e0b-20fd-445d-9f74-62c952981fbe',
  createdAt: '2026-11-14T20:00:00.000Z',
  runtimeVersion: `exposdk:${sdkVersion}`,
  launchAsset: { key: sdkVersion, contentType: 'application/javascript', url: `${customerOrigin}/ios-preview/${sdkVersion}.js` },
  assets: [],
  metadata: {},
  extra: { scopeKey: 'cena-customer', expoClient: { slug: 'cena-customer', sdkVersion } },
});
const variants = Object.fromEntries(['54.0.0', '57.0.0', '58.0.0'].map(sdk => [sdk, sample(sdk)]));
const worker = createManifestWorker({ 'cena-customer': variants });

test('returns the bundle matching the Expo Go runtime and accepts the legacy SDK header', async () => {
  const cases = [
    [{ 'Expo-Runtime-Version': 'exposdk:54.0.0' }, '54.0.0'],
    [{ 'Expo-Runtime-Version': '57.0.0' }, '57.0.0'],
    [{ 'Expo-Runtime-Version': 'exposdk:58.0.0', 'Expo-Protocol-Version': '1' }, '58.0.0'],
    [{ 'Expo-Runtime-Version': 'exposdk:UNVERSIONED', 'Exponent-SDK-Version': '57.0.0' }, '57.0.0'],
    [{}, '58.0.0'],
  ];
  for (const [headers, sdk] of cases) {
    const response = await worker.fetch(new Request(route, { headers }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('expo-protocol-version'), '1');
    assert.equal(response.headers.get('expo-sfv-version'), '0');
    assert.deepEqual(await response.json(), variants[sdk]);
  }
  const freshLaunch = await worker.fetch(new Request(route.replace('/manifest.json', '/menu/manifest.json'), {
    headers: { 'Expo-Runtime-Version': 'exposdk:58.0.0', 'Expo-Platform': 'ios' },
  }));
  assert.deepEqual(await freshLaunch.json(), variants['58.0.0']);
});

test('supports Expo Go protocol zero but refuses incompatible runtime and platform', async () => {
  const open = headers => worker.fetch(new Request(route, { headers }));
  const response = await open({ 'Expo-Protocol-Version': '0', 'Exponent-Platform': 'ios' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('expo-protocol-version'), '0');
  assert.equal((await open({ 'Expo-Runtime-Version': 'exposdk:59.0.0' })).status, 406);
  assert.equal((await open({ 'Expo-Runtime-Version': 'exposdk:55.0.0' })).status, 406);
  assert.equal((await open({ 'Exponent-Platform': 'android' })).status, 400);
});

test('item diagnostics use a separate update scope and require the temporary key', async () => {
  const key = 'a'.repeat(32);
  const diagnostics = createManifestWorker({ 'cena-customer': variants }, { key, expiresAt: Date.now() + 60_000 });
  const request = path => new Request(`https://demo.example${path}`);
  const standard = await diagnostics.fetch(request('/customer/ios-preview/menu/manifest.json'));
  assert.equal((await standard.json()).extra.expoClient.extra, undefined);
  const trace = await diagnostics.fetch(request(`/customer/ios-preview/trace/${key}/manifest.json`));
  const manifest = await trace.json();
  assert.equal(manifest.extra.scopeKey, 'cena-customer-diagnostics');
  assert.equal(manifest.extra.expoClient.extra.cenaItemTrace, key);
  const invalid = await diagnostics.fetch(new Request('https://demo.example/v1/ios-trace', {
    method: 'POST', body: JSON.stringify({ key: 'b'.repeat(32), session: 'session567', sequence: 1, event: 'meal-tap' }),
  }));
  assert.equal(invalid.status, 400);
});
