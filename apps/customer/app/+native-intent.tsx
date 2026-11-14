export function redirectSystemPath({ path }: { path: string }) {
  if (path === '/checkout/return' || path === 'checkout/return') return '/';
  try {
    const url = new URL(path);
    if (url.protocol === 'cena:' && url.hostname === 'checkout' && url.pathname === '/return') return '/';
  } catch {
    // Expo Router also passes relative paths through this handler.
  }
  return path;
}
