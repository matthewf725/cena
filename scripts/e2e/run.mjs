import { spawn, spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeStripe } from './fake-stripe.mjs';
import { runBrowserFlow } from './browser-flow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runId = `${Date.now()}${process.pid}`;
const artifactsDir = path.join(root, 'artifacts', 'e2e');
const apiPort = Number(process.env.CENA_E2E_API_PORT || 8180);
const customerPort = Number(process.env.CENA_E2E_CUSTOMER_PORT || 8081);
const restaurantPort = Number(process.env.CENA_E2E_RESTAURANT_PORT || 8082);
const metroWorkers = Number(process.env.CENA_E2E_METRO_MAX_WORKERS || 2);
const customerOrigin = process.env.CENA_E2E_CUSTOMER_ORIGIN || `http://127.0.0.1:${customerPort}`;
const restaurantOrigin = process.env.CENA_E2E_RESTAURANT_ORIGIN || `http://127.0.0.1:${restaurantPort}`;
const childProcesses = [];
let activeFake;
let lastFakeAudit = [];

function loopback(value, label) {
  const parsed = new URL(value);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error(`${label} must use a loopback host`);
  return parsed;
}
function portAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    // Probe the dual-stack wildcard, not only IPv4: a stale `::` listener on
    // Windows can occupy 127.0.0.1 too while an IPv4-only probe reports free.
    server.listen({ port, host: '::', ipv6Only: false }, () => server.close(() => resolve(true)));
  });
}
function parseEnvOutput(output) {
  const values = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)="(.*)"$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}
function command(bin, args, options = {}) {
  if (process.platform === 'win32' && bin.toLowerCase() === 'pnpm.cmd') {
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `pnpm ${args.join(' ')}`], { cwd: root, encoding: 'utf8', windowsHide: true, ...options });
  }
  return spawnSync(bin, args, { cwd: root, encoding: 'utf8', windowsHide: true, ...options });
}
function start(bin, args, env, cwd = root, showOutput = false) {
  const commandArgs = process.platform === 'win32' && bin.toLowerCase() === 'pnpm.cmd'
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `pnpm ${args.join(' ')}`]]
    : [bin, args];
  const child = spawn(commandArgs[0], commandArgs[1], { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: showOutput ? ['ignore', 'pipe', 'pipe'] : 'ignore', detached: process.platform !== 'win32' });
  child.on('exit', code => { child.cenaExitCode = code ?? 0; });
  if (showOutput) {
    child.stdout.on('data', chunk => process.stdout.write(chunk));
    child.stderr.on('data', chunk => process.stderr.write(chunk));
  }
  child.on('error', error => { console.error(`Local child process failed to start: ${error.message}`); });
  childProcesses.push(child);
  return child;
}
async function waitHttp(url, timeoutMs = 60000, child) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child && (child.killed || child.cenaExitCode !== undefined || child.exitCode !== null)) throw new Error(`Local service process exited with code ${child.cenaExitCode ?? child.exitCode} before becoming ready`);
    try { const response = await fetch(url); if (response.ok) return; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Local service did not become ready at ${url}`);
}
function pnpmBin() { return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'; }

async function main() {
  await mkdir(artifactsDir, { recursive: true });
  if (!Number.isInteger(metroWorkers) || metroWorkers < 1) throw new Error('CENA_E2E_METRO_MAX_WORKERS must be a positive integer');
  if (Number(loopback(customerOrigin, 'Customer preview URL').port) !== customerPort) throw new Error('Customer preview URL port must match CENA_E2E_CUSTOMER_PORT');
  if (Number(loopback(restaurantOrigin, 'Restaurant preview URL').port) !== restaurantPort) throw new Error('Restaurant preview URL port must match CENA_E2E_RESTAURANT_PORT');
  const status = command(pnpmBin(), ['dlx', 'supabase@3.1.0', 'status', '--output', 'env']);
  const supabase = parseEnvOutput(status.stdout || '');
  if (status.status !== 0 || !supabase.API_URL || !supabase.ANON_KEY || !supabase.SERVICE_ROLE_KEY || !supabase.MAILPIT_URL) {
    throw new Error('Local Supabase is not ready. Start it and apply schema/seed first; this runner never resets the database.');
  }
  supabase.apiUrl = loopback(supabase.API_URL, 'Supabase API URL').origin;
  supabase.anonKey = supabase.ANON_KEY;
  const mailpit = loopback(supabase.MAILPIT_URL, 'Mailpit URL');
  if (mailpit.port !== '54324') throw new Error('Mailpit must be the local Supabase service on port 54324');
  const serviceProbe = await fetch(`${supabase.apiUrl}/rest/v1/restaurants?select=id&limit=1`, { headers: { apikey: supabase.SERVICE_ROLE_KEY, authorization: `Bearer ${supabase.SERVICE_ROLE_KEY}` } });
  if (!serviceProbe.ok) throw new Error('Local Supabase REST service is unavailable');
  const mailpitProbe = await fetch(`${mailpit.origin}/api/v1/messages`);
  if (!mailpitProbe.ok) throw new Error('Local Mailpit is required for real OTP flow');

  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  loopback(apiOrigin, 'Go API URL');
  if (!await portAvailable(apiPort)) throw new Error(`Port ${apiPort} is occupied. Stop the conflicting process or set CENA_E2E_API_PORT; existing services are never killed.`);
  const goDir = path.join(root, 'backend', 'go');
  const buildDir = path.join(artifactsDir, 'bin');
  await mkdir(buildDir, { recursive: true });
  const apiBinary = path.join(buildDir, process.platform === 'win32' ? 'cena-api.exe' : 'cena-api');
  const build = command(process.env.CENA_E2E_GO_BIN || 'go', ['build', '-o', apiBinary, './cmd/cena-api'], {
    cwd: goDir,
    stdio: 'inherit',
  });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error('The local Go API failed to build');
  const webhookSecret = `whsec_cena_e2e_${runId}`;
  const fake = createFakeStripe({ webhookUrl: `${apiOrigin}/v1/stripe/webhook`, webhookSecret, runId });
  activeFake = fake;
  lastFakeAudit = fake.audit;
  const fakeOrigin = await fake.listen();
  const go = start(apiBinary, [], {
    PORT: String(apiPort), CENA_API_BIND_HOST: '127.0.0.1',
    SUPABASE_URL: supabase.apiUrl, SUPABASE_ANON_KEY: supabase.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: supabase.SERVICE_ROLE_KEY,
    STRIPE_SECRET_KEY: `sk_test_cena_e2e_${runId}`, STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_API_BASE_URL: fakeOrigin, STRIPE_APPLICATION_FEE_CENTS: '175',
    CENA_WEB_BASE_URL: 'https://cena.local.test',
    CORS_ALLOWED_ORIGINS: [...new Set([customerOrigin, restaurantOrigin, customerOrigin.replace('localhost', '127.0.0.1'), restaurantOrigin.replace('localhost', '127.0.0.1')])].join(','),
  }, goDir, true);
  await waitHttp(`${apiOrigin}/healthz`, 15000, go);
  await new Promise(resolve => setTimeout(resolve, 250));
  if (go.cenaExitCode !== undefined || go.exitCode !== null) throw new Error(`The test Go API exited with code ${go.cenaExitCode ?? go.exitCode}`);

  for (const origin of [customerOrigin, restaurantOrigin]) {
    const preflight = await fetch(`${apiOrigin}/v1/restaurants/00000000-0000-0000-0000-000000000000/payments`, {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
    const allowedOrigin = preflight.headers.get('access-control-allow-origin');
    if (preflight.status !== 204 || allowedOrigin !== origin) throw new Error(`Go API CORS preflight failed for ${origin} (status ${preflight.status}, allowed origin ${allowedOrigin || 'none'})`);
    console.log(`CORS preflight: ${origin} -> ${allowedOrigin}`);
  }
  if (process.env.CENA_E2E_PREFLIGHT_ONLY === '1') return;

  const appEnv = { EXPO_NO_DOTENV: '1', EXPO_PUBLIC_SUPABASE_URL: supabase.apiUrl, EXPO_PUBLIC_SUPABASE_ANON_KEY: supabase.anonKey, EXPO_PUBLIC_CENA_API_URL: apiOrigin, CI: '1' };
  const previews = [
    { port: customerPort, origin: customerOrigin, args: ['--dir', 'apps/customer', 'exec', 'expo', 'start', '--web', '--port', String(customerPort), '--clear', '--max-workers', String(metroWorkers)] },
    { port: restaurantPort, origin: restaurantOrigin, args: ['--dir', 'apps/restaurant', 'exec', 'expo', 'start', '--web', '--port', String(restaurantPort), '--clear', '--max-workers', String(metroWorkers)] },
  ];
  for (const preview of previews) {
    if (!await portAvailable(preview.port)) throw new Error(`Preview port ${preview.port} is occupied. Set CENA_E2E_CUSTOMER_PORT and CENA_E2E_RESTAURANT_PORT to free ports; the runner never reuses potentially stale preview bundles.`);
    console.log(`Starting fresh Expo preview at ${preview.origin} with local API ${apiOrigin}`);
    const previewProcess = start(pnpmBin(), preview.args, { ...appEnv, BROWSER: 'none' }, root, true);
    await waitHttp(preview.origin, 120000, previewProcess);
    await new Promise(resolve => setTimeout(resolve, 250));
    if (previewProcess.cenaExitCode !== undefined || previewProcess.exitCode !== null) throw new Error(`Expo preview process exited for ${preview.origin}`);
  }

  try {
    const browsers = (process.env.CENA_E2E_BROWSERS || 'chromium').split(',').map(value => value.trim()).filter(Boolean);
    const results = [];
    const { writeFile } = await import('node:fs/promises');
    for (const browserName of browsers) {
      results.push(await runBrowserFlow({ browserName, supabase: { apiUrl: supabase.apiUrl, anonKey: supabase.anonKey }, serviceRoleKey: supabase.SERVICE_ROLE_KEY, apiOrigin, customerOrigin, restaurantOrigin, fake: { ...fake, origin: fakeOrigin }, runId, artifactsDir }));
      await writeFile(path.join(artifactsDir, 'report.json'), JSON.stringify({ runId, results }, null, 2));
    }
    for (const result of results) console.log(`${result.browser}: PASS (${result.stages.length} stages, final ${result.finalStatus}, order ${result.orderId})`);
  } finally {
    await fake.close();
    activeFake = undefined;
  }
}

try { await main(); }
catch (error) {
  console.error(`E2E failed: ${error instanceof Error ? error.message : String(error)}`);
  if (lastFakeAudit.length) console.error(`Fake Stripe audit: ${JSON.stringify(lastFakeAudit)}`);
  process.exitCode = 1;
}
finally {
  await activeFake?.close().catch(() => {});
  for (const child of childProcesses.reverse()) {
    if (!child.pid) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* exited */ } }
  }
}
