// The chess site's server: serves site/ and answers /healthz. Node's own modules only, for now.
// Accounts and live games (stage 3) will be added here.
//   node server/server.mjs              listens on PORT (default 3000)
//   node server/server.mjs --port 8090  for trying the site on this PC (npm run serve)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEADERS } from './headers.mjs';

const SITE = fileURLToPath(new URL('../site/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra });
  res.end(body);
}

// A file from site/. Paths can't climb out of it (".." is resolved first and checked). Each file
// gets an ETag from its size and time, so a browser checking for a newer copy gets a quick 304.
async function file(req, res, path) {
  let full = normalize(join(SITE, path));
  if (!(full + sep).startsWith(SITE)) return send(res, 403, 'text/plain', 'Forbidden');   // SITE ends with a separator
  try {
    let info = await stat(full);
    if (info.isDirectory()) { full = join(full, 'index.html'); info = await stat(full); }
    const tag = `W/"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
    if (req.headers['if-none-match'] === tag) return send(res, 304, TYPES[extname(full)] || 'application/octet-stream', undefined, { ETag: tag });
    const body = req.method === 'HEAD' ? undefined : await readFile(full);
    send(res, 200, TYPES[extname(full)] || 'application/octet-stream', body, { ETag: tag, 'Content-Length': info.size });
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  }
}

export function handle(req, res) {
  let path;
  // The path straight from the request line, without its ?query. (Not new URL(): it reads a path
  // starting with // as another host, so "//" became a 400.) file() keeps it inside site/.
  try { path = decodeURIComponent(req.url.split('?')[0]); } catch { return send(res, 400, 'text/plain', 'Bad request'); }
  if (path === '/healthz') return send(res, 200, 'application/json', JSON.stringify({ ok: true }), { 'Cache-Control': 'no-store' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed', { Allow: 'GET, HEAD' });
  return file(req, res, path);
}

// Starts listening; port 0 picks a free one (the tests do). Resolves with the http.Server.
export function start({ port = 3000, host = '0.0.0.0' } = {}) {
  const server = createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch(() => { if (!res.headersSent) send(res, 500, 'text/plain', 'Something went wrong'); });
  });
  return new Promise(ok => server.listen(port, host, () => ok(server)));
}

// Run directly: listen, and stop cleanly when the container is stopped
if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const flag = process.argv.indexOf('--port');
  const port = flag > 0 ? Number(process.argv[flag + 1]) : Number(process.env.PORT) || 3000;
  const host = flag > 0 ? '127.0.0.1' : '0.0.0.0';   // on this PC, only this PC; in the container, its own network
  const server = await start({ port, host });
  console.log(`Chess on http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}/`);
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
