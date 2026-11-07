// Serves site/ on this PC the way nginx will on the server: plain files, the right types (the
// engine's .wasm must be application/wasm), nothing cached. `npm run serve` to try the site by hand.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = fileURLToPath(new URL('../site/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

// The same headers nginx sends on the server (P:\websites\chess\nginx.conf): keep the two the same,
// so the tests catch the security policy blocking something the site needs.
//   no-cache: browsers check for a newer file every time (cheap: unchanged files answer 304), so an
//     update reaches visitors at once. Cloudflare follows it (Browser Cache TTL: Respect Existing Headers).
//   no-transform: Cloudflare passes pages on unchanged, so it doesn't add its analytics script.
//   Content-Security-Policy: only files from this site may run, load or be fetched. 'wasm-unsafe-eval'
//     lets Stockfish compile its WebAssembly; data: images are the piece set's built-in pictures.
export const HEADERS = {
  'Cache-Control': 'no-cache, no-transform',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function serve(port = 0) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(SITE, path));
    if (!file.startsWith(SITE.replace(/[\\/]$/, '') + sep) && file !== SITE) { res.writeHead(403).end(); return; }
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', ...HEADERS });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });
  return new Promise(ok => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const server = await serve(Number(process.env.PORT) || 8090);
  console.log(`Chess on http://127.0.0.1:${server.address().port}/ (Ctrl+C to stop)`);
}
