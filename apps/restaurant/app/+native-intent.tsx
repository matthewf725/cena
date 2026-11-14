export function redirectSystemPath({ path }: { path: string }) {
  if (path === '/connect/return' || path === 'connect/return') return '/';
  try {
    const url = new URL(path);
    if (url.protocol === 'cena-restaurant:' && url.hostname === 'connect' && url.pathname === '/return') return '/';
  } catch {
    // Expo Router also passes relative paths through this handler.
  }
  return path;
}
