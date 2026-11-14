const SUPPORTED_SDKS = new Set(['54.0.0', '57.0.0', '58.0.0']);
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Expo-Platform, Expo-Protocol-Version, Expo-Runtime-Version, Exponent-Platform, Exponent-SDK-Version',
  'Access-Control-Max-Age': '600',
};

const customerPreview = {
  url: 'https://cena-calpoly-customer.trustworthybasket2.chatgpt.site/ios-preview/manifest.json',
  slug: 'cena-customer',
  scopeKey: 'cena-customer',
};

const MANIFESTS = new Map([
  ['/customer/ios-preview/manifest.json', customerPreview],
  ['/customer/ios-preview/menu/manifest.json', customerPreview],
  ['/restaurant/ios-preview/manifest.json', {
    url: 'https://cena-calpoly-restaurant.trustworthybasket2.chatgpt.site/ios-preview/manifest.json',
    slug: 'cena-restaurant',
    scopeKey: 'cena-restaurant',
  }],
]);

function responseHeaders(contentType = 'application/json', protocol = '1') {
  return new Headers({
    ...CORS_HEADERS,
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Type': contentType,
    'Expo-Protocol-Version': protocol,
    'Expo-SFV-Version': '0',
    'Expo-Manifest-Filters': '',
    'Expo-Server-Defined-Headers': '',
    Vary: 'Accept, Expo-Platform, Expo-Protocol-Version, Expo-Runtime-Version, Exponent-SDK-Version',
    'X-Content-Type-Options': 'nosniff',
  });
}

function jsonError(status, error, method = 'GET') {
  const body = method === 'HEAD' ? null : JSON.stringify({ error });
  return new Response(body, { status, headers: responseHeaders() });
}

function suppliedValue(request, url, headerName, queryName) {
  const header = request.headers.get(headerName);
  const query = url.searchParams.get(queryName);
  if (header && query && header !== query) return { conflict: true };
  return { value: header ?? query };
}

function isSafePreviewManifest(manifest, config, upstream, sdkVersion) {
  if (!manifest || typeof manifest !== 'object'
    || typeof manifest.id !== 'string' || typeof manifest.createdAt !== 'string'
    || manifest.runtimeVersion !== `exposdk:${sdkVersion}`
    || !manifest.launchAsset || !Array.isArray(manifest.assets)
    || !manifest.metadata || typeof manifest.metadata !== 'object'
    || !manifest.extra || manifest.extra.scopeKey !== config.scopeKey
    || !manifest.extra.expoClient || manifest.extra.expoClient.slug !== config.slug
    || manifest.extra.expoClient.sdkVersion !== sdkVersion) return false;

  const allowedPrefix = `${upstream.origin}/ios-preview/`;
  const assets = [manifest.launchAsset, ...manifest.assets];
  return assets.every(asset => {
    if (!asset || typeof asset.key !== 'string' || typeof asset.contentType !== 'string'
      || typeof asset.url !== 'string') return false;
    try {
      const assetUrl = new URL(asset.url);
      return assetUrl.protocol === 'https:' && assetUrl.href.startsWith(allowedPrefix)
        && assetUrl.origin === upstream.origin && !assetUrl.username && !assetUrl.password;
    } catch {
      return false;
    }
  });
}

function sdkFromRequest(runtime, sdkHeader, manifests) {
  const candidate = runtime?.trim().replace(/^exposdk:/i, '');
  const header = sdkHeader?.split(',').map(value => value.trim()).find(value => SUPPORTED_SDKS.has(value));
  if (!candidate || candidate.toUpperCase() === 'UNVERSIONED') {
    return header ?? ['58.0.0', '57.0.0', '54.0.0'].find(sdk => Object.hasOwn(manifests, sdk));
  }
  return candidate;
}

async function readBounded(stream, limit) {
  if (!stream) throw new Error('empty body');
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('body too large');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function geocode(request) {
  if (request.method !== 'POST') return jsonError(405, 'Method not allowed.');
  const body = await readBounded(request.body, 2048).catch(() => null);
  let input;
  try { input = JSON.parse(body); } catch { return jsonError(400, 'enter a full US street address'); }
  const address = typeof input?.address === 'string' ? input.address.trim() : '';
  const size = new TextEncoder().encode(address).length;
  if (size < 8 || size > 500 || /[\x00-\x1f\x7f]/.test(address)) return jsonError(400, 'enter a full US street address');
  const endpoint = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
  endpoint.search = new URLSearchParams({ address, benchmark: 'Public_AR_Current', format: 'json' }).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) return jsonError(502, 'geocoder unavailable');
    const raw = await readBounded(response.body, 1 << 20);
    let result;
    try { result = JSON.parse(raw); } catch { return jsonError(502, 'invalid geocoder response'); }
    const matches = result?.result?.addressMatches;
    if (!Array.isArray(matches)) return jsonError(502, 'invalid geocoder response');
    if (!matches.length) return jsonError(404, 'address not found');
    const match = matches[0];
    if (String(match?.addressComponents?.state ?? '').trim().toUpperCase() !== 'CA') return jsonError(422, 'pickup locations are currently limited to California');
    const label = match?.matchedAddress;
    const longitude = match?.coordinates?.x;
    const latitude = match?.coordinates?.y;
    if (typeof label !== 'string' || !label.trim() || !Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return jsonError(502, 'invalid geocoder response');
    return new Response(JSON.stringify({ label, latitude, longitude }), { headers: responseHeaders() });
  } catch {
    return jsonError(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'geocoder timed out' : 'geocoder unavailable');
  } finally { clearTimeout(timeout); }
}

const traceEvents = new Set(['boot','meal-tap','recent-tap','detail-requested','detail-rendered','detail-layout','detail-frame','detail-close','detail-add','detail-error']);

export function createManifestWorker(previews, diagnostics = {}) {
  const tracePath = typeof diagnostics.key === 'string' && /^[a-f0-9]{32}$/.test(diagnostics.key)
    ? `/customer/ios-preview/trace/${diagnostics.key}` : null;
  const traceActive = () => Boolean(tracePath && Date.now() < diagnostics.expiresAt);
  return {
    async fetch(request) {
      const requestUrl = new URL(request.url);
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: responseHeaders() });
      }
      if (requestUrl.pathname === '/v1/geocode') return geocode(request);
      if (requestUrl.pathname === '/v1/ios-trace' && request.method === 'POST') {
        if (!traceActive()) return jsonError(404, 'Diagnostics are unavailable.');
        try {
          const { key, session, sequence, event } = JSON.parse(await readBounded(request.body, 300));
          if (key !== diagnostics.key || typeof session !== 'string' || !/^[a-z0-9]{8,24}$/.test(session)
            || !Number.isInteger(sequence) || sequence < 1 || sequence > 1000 || !traceEvents.has(event)) {
            return jsonError(400, 'Invalid diagnostic marker.');
          }
          console.log('Cena iPhone trace', JSON.stringify({ session, sequence, event }));
          return new Response(null, { status: 204, headers: responseHeaders() });
        } catch { return jsonError(400, 'Invalid diagnostic marker.'); }
      }
      if (request.method !== 'GET') return jsonError(405, 'Method not allowed.');

      if (traceActive() && requestUrl.pathname === tracePath) {
        const deepLink = `exps://cena-calpoly-ios.trustworthybasket2.chatgpt.site${tracePath}/manifest.json`;
        return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cena iPhone diagnostics</title><body style="margin:32px;background:#FAF6F3;color:#46110E;font:17px system-ui"><h1>Cena iPhone diagnostics</h1><p>This link sends screen lifecycle and tap markers for the item issue.</p><a style="display:inline-block;padding:16px;color:#fff;background:#5D100A;border-radius:12px" href="${deepLink}">Open in Expo Go</a></body></html>`, { headers: responseHeaders('text/html; charset=utf-8') });
      }
      const isTrace = traceActive() && requestUrl.pathname === `${tracePath}/manifest.json`;
      const config = isTrace ? customerPreview : MANIFESTS.get(requestUrl.pathname);
      if (!config) return jsonError(404, 'Unknown iOS preview manifest.');

      const platform = suppliedValue(request, requestUrl, 'Expo-Platform', 'platform');
      const runtime = suppliedValue(request, requestUrl, 'Expo-Runtime-Version', 'runtimeVersion');
      const protocol = request.headers.get('Expo-Protocol-Version') ?? requestUrl.searchParams.get('protocolVersion');
      if (platform.conflict || runtime.conflict) return jsonError(400, 'Conflicting platform or runtime values.');
      const iosPlatform = platform.value ?? request.headers.get('Exponent-Platform');
      if (iosPlatform && iosPlatform !== 'ios') return jsonError(400, 'Only iOS preview manifests are available.');
      if (protocol && !['0', '1'].includes(protocol)) return jsonError(406, 'Use Expo Updates protocol version 0 or 1.');

      const manifests = previews[config.slug] ?? {};
      const sdkVersion = sdkFromRequest(runtime.value, request.headers.get('Exponent-SDK-Version'), manifests);
      const manifest = manifests[sdkVersion];
      if (!SUPPORTED_SDKS.has(sdkVersion) || !manifest) {
        return jsonError(406, 'This Expo Go runtime has no Cena preview. Update Expo Go from the App Store.');
      }
      if (!isSafePreviewManifest(manifest, config, new URL(config.url), sdkVersion)) {
        return jsonError(502, 'The preview manifest did not match the requested Expo SDK.');
      }

      const output = isTrace ? {
        ...manifest,
        id: diagnostics.updateIds?.[sdkVersion] ?? manifest.id,
        extra: { ...manifest.extra, scopeKey: 'cena-customer-diagnostics', expoClient: { ...manifest.extra.expoClient,
          extra: { ...manifest.extra.expoClient.extra, cenaItemTrace: diagnostics.key } } },
      } : manifest;
      return new Response(JSON.stringify(output), {
        status: 200,
        headers: responseHeaders('application/expo+json', protocol === '0' ? '0' : '1'),
      });
    },
  };
}
