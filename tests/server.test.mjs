// The server on its own, no browser: node --test tests/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { start } from '../server/server.mjs';
import { HEADERS } from '../server/headers.mjs';

let server, base;
before(async () => { server = await start({ port: 0, host: '127.0.0.1' }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

// A raw request, so paths like /%2e%2e/ reach the server exactly as written (fetch would tidy them)
const raw = (path, { method = 'GET', headers = {} } = {}) => new Promise((ok, fail) => {
  const req = request(`${base}${path}`, { method, headers, path }, res => {
    let body = '';
    res.on('data', d => { body += d; });
    res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', fail);
  req.end();
});

test('the page, with every security header', async () => {
  const r = await raw('/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/html/);
  for (const [k, v] of Object.entries(HEADERS)) assert.equal(r.headers[k.toLowerCase()], v, k);
  assert.match(r.body, /<title>Chess/);
});

test('/healthz answers for the deploy script’s health check', async () => {
  const r = await raw('/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('the engine is served as WebAssembly', async () => {
  const r = await raw('/vendor/stockfish/stockfish-19-lite-single.wasm', { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/wasm');
  assert.equal(r.body, '', 'HEAD sends no body');
  assert.ok(Number(r.headers['content-length']) > 1_000_000);
});

test('an unchanged file answers 304 to a browser that has it', async () => {
  const first = await raw('/js/app.js');
  const again = await raw('/js/app.js', { headers: { 'If-None-Match': first.headers.etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body, '');
});

test('nothing outside site/ can be reached', async () => {
  for (const path of ['/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/Windows/win.ini', '/vendor/%2e%2e/%2e%2e/server/server.mjs']) {
    const r = await raw(path);
    assert.ok(r.status === 403 || r.status === 404, `${path} answered ${r.status}`);
    assert.doesNotMatch(r.body, /"name"|import |\[fonts\]/, `${path} leaked a file`);
  }
});

test('missing files are 404, with the same headers', async () => {
  const r = await raw('/no-such-page');
  assert.equal(r.status, 404);
  assert.equal(r.headers['content-security-policy'], HEADERS['Content-Security-Policy']);
});

test('only GET and HEAD', async () => {
  const r = await raw('/', { method: 'POST' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'GET, HEAD');
});

test('a broken URL is a 400, not a crash', async () => {
  const r = await raw('/%E0%A4%A');
  assert.equal(r.status, 400);
  assert.equal((await raw('/healthz')).status, 200, 'and the server keeps going');
});
