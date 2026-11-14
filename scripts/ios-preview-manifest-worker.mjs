const SUPPORTED_SDKS = new Set(['54.0.0', '57.0.0', '58.0.0']);
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Expo-Platform, Expo-Protocol-Version, Expo-Runtime-Version, Exponent-Platform, Exponent-SDK-Version',
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

export function createManifestWorker(previews) {
  return {
    async fetch(request) {
      const requestUrl = new URL(request.url);
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: responseHeaders() });
      }
      if (request.method !== 'GET') return jsonError(405, 'Method not allowed.');

      const config = MANIFESTS.get(requestUrl.pathname);
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

      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: responseHeaders('application/expo+json', protocol === '0' ? '0' : '1'),
      });
    },
  };
}
