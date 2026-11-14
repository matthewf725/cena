import { writeFile } from 'node:fs/promises';

const url = process.env.CENA_SITE_SUPABASE_URL?.trim();
const key = process.env.CENA_SITE_SUPABASE_PUBLIC_KEY?.trim();

if (!url || !key) {
  if (url || key) throw new Error('Set both Cena waitlist environment variables.');
} else {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('CENA_SITE_SUPABASE_URL must be an HTTPS project origin.');
  }

  const legacyPublicKey = /^eyJ[\w.-]+$/.test(key)
    && JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')).role === 'anon';
  if (!key.startsWith('sb_publishable_') && !legacyPublicKey) {
    throw new Error('CENA_SITE_SUPABASE_PUBLIC_KEY must be a Supabase publishable or anon key.');
  }

  const config = JSON.stringify({ SUPABASE_URL: endpoint.origin, SUPABASE_ANON_KEY: key });
  await writeFile(new URL('../dist/config.js', import.meta.url), `window.CENA_CONFIG = ${config};\n`);
}
