import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../apps/site/dist', import.meta.url));
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const supabaseUrl = process.env.CENA_SITE_SUPABASE_URL;
    const supabaseKey = process.env.CENA_SITE_SUPABASE_PUBLIC_KEY;
    if (path === '/config.js' && supabaseUrl && supabaseKey) {
      const config = JSON.stringify({ SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: supabaseKey });
      response.writeHead(200, { 'Content-Type': contentTypes['.js'], 'Cache-Control': 'no-store' });
      response.end(`window.CENA_CONFIG = ${config};\n`);
      return;
    }
    const file = resolve(root, path === '/' ? 'index.html' : `.${path}`);
    if (!file.startsWith(`${root}${sep}`) || !(await stat(file)).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
}).listen(Number(process.env.PORT ?? 4173), '127.0.0.1', function () {
  console.log(`Cena signup site at http://127.0.0.1:${this.address().port}`);
});
