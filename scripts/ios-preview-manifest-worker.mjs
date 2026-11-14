const RUNTIME_VERSION = 'exposdk:54.0.0';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Expo-Platform, Expo-Protocol-Version, Expo-Runtime-Version',
  'Access-Control-Max-Age': '600',
};

const MANIFESTS = new Map([
  ['/customer/ios-preview/manifest.json', {
    url: 'https://cena-calpoly-customer.trustworthybasket2.chatgpt.site/ios-preview/manifest.json',
    slug: 'cena-customer',
    scopeKey: 'cena-customer',
  }],
  ['/restaurant/ios-preview/manifest.json', {
    url: 'https://cena-calpoly-restaurant.trustworthybasket2.chatgpt.site/ios-preview/manifest.json',
    slug: 'cena-restaurant',
    scopeKey: 'cena-restaurant',
  }],
]);

function responseHeaders(contentType = 'application/json') {
  return new Headers({
    ...CORS_HEADERS,
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Type': contentType,
    'Expo-Protocol-Version': '1',
    'Expo-SFV-Version': '0',
    'Expo-Manifest-Filters': '',
    'Expo-Server-Defined-Headers': '',
    Vary: 'Accept, Expo-Platform, Expo-Protocol-Version, Expo-Runtime-Version',
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

function isSafePreviewManifest(manifest, config, upstream) {
  if (!manifest || typeof manifest !== 'object'
    || typeof manifest.id !== 'string' || typeof manifest.createdAt !== 'string'
    || manifest.runtimeVersion !== RUNTIME_VERSION
    || !manifest.launchAsset || !Array.isArray(manifest.assets)
    || !manifest.metadata || typeof manifest.metadata !== 'object'
    || !manifest.extra || manifest.extra.scopeKey !== config.scopeKey
    || !manifest.extra.expoClient || manifest.extra.expoClient.slug !== config.slug
    || manifest.extra.expoClient.sdkVersion !== '54.0.0') return false;

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
    if (platform.value && platform.value !== 'ios') return jsonError(400, 'Only iOS preview manifests are available.');
    if (runtime.value && runtime.value !== RUNTIME_VERSION) return jsonError(406, 'The requested runtime is not available.');
    if (protocol && protocol !== '1') return jsonError(406, 'Only Expo Updates protocol version 1 is available.');

    const manifest = previews[config.slug];
    if (!isSafePreviewManifest(manifest, config, new URL(config.url))) {
      return jsonError(502, 'The preview manifest did not match the expected Expo SDK 54 app.');
    }

    return new Response(JSON.stringify(manifest), { status: 200, headers: responseHeaders('application/expo+json') });
  },
  };
}
