import test from 'node:test';
import assert from 'node:assert/strict';
import { createManifestWorker } from './ios-preview-manifest-worker.mjs';

const worker = createManifestWorker({});
const request = body => new Request('https://preview.example/v1/geocode', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

test('geocode validates input and restricts methods', async () => {
  assert.equal((await worker.fetch(request({ address: 'short' }))).status, 400);
  assert.equal((await worker.fetch(request({ address: '123 Main\nStreet' }))).status, 400);
  assert.equal((await worker.fetch(new Request('https://preview.example/v1/geocode'))).status, 405);
});

test('geocode uses Census and accepts only valid California matches', async () => {
  const original = globalThis.fetch;
  let match = { matchedAddress: '1 GRAND AVE, SAN LUIS OBISPO, CA, 93407', coordinates: { x: -120.65, y: 35.3 }, addressComponents: { state: 'CA' } };
  globalThis.fetch = async url => {
    assert.equal(url.origin, 'https://geocoding.geo.census.gov');
    assert.equal(url.searchParams.get('benchmark'), 'Public_AR_Current');
    return Response.json({ result: { addressMatches: [match] } });
  };
  try {
    const response = await worker.fetch(request({ address: '1 Grand Ave, San Luis Obispo, CA' }));
    assert.deepEqual(await response.json(), { label: match.matchedAddress, latitude: 35.3, longitude: -120.65 });
    match = { ...match, addressComponents: { state: 'NV' } };
    assert.equal((await worker.fetch(request({ address: '1 Main St, Reno, NV' }))).status, 422);
    match = { ...match, addressComponents: { state: 'CA' }, coordinates: { x: 999, y: 35 } };
    assert.equal((await worker.fetch(request({ address: '1 Main St, California' }))).status, 502);
  } finally { globalThis.fetch = original; }
});
