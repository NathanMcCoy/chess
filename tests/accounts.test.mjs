// Accounts: the /api/ routes over HTTP, and the parts that need a controllable clock directly.
// Each run uses a throwaway data folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/server.mjs';
import { openDb } from '../server/db.mjs';
import { signUp, signIn, startSession, sessionAccount, SESSION_DAYS } from '../server/accounts.mjs';

const dir = mkdtempSync(join(tmpdir(), 'chess-accounts-'));
let server, base, ip = 0;
before(async () => { server = await start({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'http'), secureCookies: false }); base = `http://127.0.0.1:${server.address().port}`; });
// Close every connection, wait for the server (which closes its database), then remove the folder:
// Windows can't delete a file that's still open
after(async () => {
  const closed = new Promise(r => server.close(r));
  server.closeAllConnections();
  await closed;
  rmSync(dir, { recursive: true, force: true });
});

const ITALIAN = { variant: 'chess', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'] };
// Each test can be its own visitor, so the per-address limits don't run into each other
const visitor = () => `10.0.0.${++ip}`;
async function call(path, { method = 'GET', body, cookie, from = visitor(), headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json', 'X-Requested-With': 'chess' }), ...(cookie && { Cookie: cookie }), 'CF-Connecting-IP': from, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json(), setCookie, cookie: setCookie && setCookie.split(';')[0] };
}

test('signed out at first', async () => {
  assert.deepEqual((await call('/api/me')).body, { name: null });
});

test('signing up checks the name and the opening', async () => {
  const bad = async (body, status, re) => { const r = await call('/api/signup', { method: 'POST', body }); assert.equal(r.status, status, JSON.stringify(body)); assert.match(r.body.error, re); };
  await bad({ name: 'ab', secret: ITALIAN }, 400, /3 to 20/);
  await bad({ name: 'has space', secret: ITALIAN }, 400, /3 to 20/);
  await bad({ name: 'Stockfish', secret: ITALIAN }, 400, /reserved/);
  await bad({ name: 'nomoves', secret: { variant: 'chess', moves: [] } }, 400, /at least one/);
  await bad({ name: 'illegal', secret: { variant: 'chess', moves: ['e2e4', 'e2e4'] } }, 400, /legal/);
  await bad({ name: 'novariant', secret: { variant: 'checkers', moves: ['e2e4'] } }, 400, /board/);
  await bad({ name: 'toolong', secret: { variant: 'chess', moves: Array(41).fill('g1f3') } }, 400, /up to 40/);
});

test('sign up, stay signed in, and the name is taken whatever its case', async () => {
  const r = await call('/api/signup', { method: 'POST', body: { name: 'Nathan', secret: ITALIAN } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { name: 'Nathan' });
  assert.match(r.setCookie, /^chess_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=7776000$/);
  assert.deepEqual((await call('/api/me', { cookie: r.cookie })).body, { name: 'Nathan' });
  const again = await call('/api/signup', { method: 'POST', body: { name: 'NATHAN', secret: ITALIAN } });
  assert.equal(again.status, 409);
});

test('the cookie is Secure on the real server', async () => {
  const s = await start({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'secure') });
  const res = await fetch(`http://127.0.0.1:${s.address().port}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'chess' }, body: JSON.stringify({ name: 'secure', secret: ITALIAN }) });
  assert.match(res.headers.get('set-cookie'), /; Secure$/);
  s.close();
});

test('sign in: the right opening, in the right order', async () => {
  await call('/api/signup', { method: 'POST', body: { name: 'orderly', secret: ITALIAN } });
  const ok = await call('/api/signin', { method: 'POST', body: { name: 'ORDERLY', secret: ITALIAN } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { name: 'orderly' }, 'the name as it was signed up');
  assert.deepEqual((await call('/api/me', { cookie: ok.cookie })).body, { name: 'orderly' });
  // The same final position by another order is a different opening
  const transposed = { variant: 'chess', moves: ['g1f3', 'b8c6', 'e2e4', 'e7e5', 'f1c4'] };
  assert.equal((await call('/api/signin', { method: 'POST', body: { name: 'orderly', secret: transposed } })).status, 401);
});

test('a wrong opening and an unknown name get the same answer', async () => {
  await call('/api/signup', { method: 'POST', body: { name: 'samewords', secret: ITALIAN } });
  const wrong = await call('/api/signin', { method: 'POST', body: { name: 'samewords', secret: { variant: 'chess', moves: ['d2d4'] } } });
  const nobody = await call('/api/signin', { method: 'POST', body: { name: 'nobodyhere', secret: ITALIAN } });
  assert.equal(wrong.status, 401);
  assert.equal(nobody.status, 401);
  assert.equal(wrong.body.error, nobody.body.error);
  const junk = await call('/api/signin', { method: 'POST', body: { name: 'samewords', secret: 'e4' } });
  assert.equal(junk.status, 401);
  assert.equal(junk.body.error, wrong.body.error);
});

test('signing out ends the session', async () => {
  const r = await call('/api/signup', { method: 'POST', body: { name: 'leaver', secret: ITALIAN } });
  const out = await call('/api/signout', { method: 'POST', body: {}, cookie: r.cookie });
  assert.match(out.setCookie, /^chess_session=; .*Max-Age=0/);
  assert.deepEqual((await call('/api/me', { cookie: r.cookie })).body, { name: null }, 'the old cookie no longer works');
});

test('changes must come from the site’s own pages', async () => {
  const body = JSON.stringify({ name: 'csrf', secret: ITALIAN });
  const post = headers => fetch(`${base}/api/signup`, { method: 'POST', headers: { 'CF-Connecting-IP': visitor(), ...headers }, body });
  assert.equal((await post({ 'Content-Type': 'application/json' })).status, 403, 'no X-Requested-With');
  assert.equal((await post({ 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'chess' })).status, 403, 'a form');
  assert.equal((await post({ 'Content-Type': 'application/json', 'X-Requested-With': 'chess', Origin: 'https://evil.example' })).status, 403, 'another site');
  assert.equal((await post({ 'Content-Type': 'application/json', 'X-Requested-With': 'chess', Origin: 'null' })).status, 403, 'a sandboxed page');
  assert.equal((await post({ 'Content-Type': 'application/json', 'X-Requested-With': 'chess', Origin: base })).status, 201, 'this site');
});

test('the current game is kept per account', async () => {
  assert.equal((await call('/api/game')).status, 401, 'signed out');
  const r = await call('/api/signup', { method: 'POST', body: { name: 'player', secret: ITALIAN } });
  assert.deepEqual((await call('/api/game', { cookie: r.cookie })).body, { data: null, updated: null });
  const data = { pgn: '1. e4 e5 *', player: 'w', level: 3, variant: 'chess' };
  const put = await call('/api/game', { method: 'PUT', body: { data }, cookie: r.cookie });
  assert.equal(put.status, 200);
  const got = await call('/api/game', { cookie: r.cookie });
  assert.deepEqual(got.body.data, data);
  assert.equal(got.body.updated, put.body.updated);
  assert.equal((await call('/api/game', { method: 'PUT', body: { data: 'nope' }, cookie: r.cookie })).status, 400);
  const other = await call('/api/signup', { method: 'POST', body: { name: 'other', secret: ITALIAN } });
  assert.equal((await call('/api/game', { cookie: other.cookie })).body.data, null, 'another account doesn’t see it');
});

test('too much data is refused', async () => {
  const r = await call('/api/signup', { method: 'POST', body: { name: 'bigsender', secret: ITALIAN } });
  const huge = await call('/api/game', { method: 'PUT', body: { data: { pgn: 'x'.repeat(300 * 1024) } }, cookie: r.cookie });
  assert.equal(huge.status, 413);
});

test('five sign-ups an hour from one address', async () => {
  const from = visitor();
  for (let i = 0; i < 5; i++) assert.equal((await call('/api/signup', { method: 'POST', body: { name: `many${i}`, secret: ITALIAN }, from })).status, 201);
  const sixth = await call('/api/signup', { method: 'POST', body: { name: 'many5', secret: ITALIAN }, from });
  assert.equal(sixth.status, 429);
  assert.equal((await call('/api/signup', { method: 'POST', body: { name: 'elsewhere', secret: ITALIAN } })).status, 201, 'another address is fine');
});

test('the database keeps only a hash of the opening', async () => {
  const db = openDb(join(dir, 'http'));
  const row = db.prepare("SELECT secret_hash, secret_salt FROM accounts WHERE name = 'Nathan'").get();
  db.close();
  assert.equal(Buffer.from(row.secret_hash).length, 32);
  assert.equal(Buffer.from(row.secret_salt).length, 16);
  for (const f of readdirSync(join(dir, 'http'))) {
    const bytes = readFileSync(join(dir, 'http', f)).toString('latin1');
    assert.ok(!bytes.includes('e2e4 e7e5'), `the opening's moves appear in ${f}`);
  }
});

// With a clock the test controls
test('wrong openings lock the account: 5 in a row, then 1 minute, doubling', async () => {
  const db = openDb(join(dir, 'clock'));
  await signUp(db, 'guarded', ITALIAN, 0);
  const wrong = { variant: 'chess', moves: ['d2d4'] };
  let t = 1000;
  for (let i = 0; i < 5; i++) await assert.rejects(signIn(db, 'guarded', wrong, t), e => e.status === 401);
  await assert.rejects(signIn(db, 'guarded', ITALIAN, t + 1000), e => e.status === 429 && /1 minute/.test(e.message), 'locked, even with the right one');
  t += 61_000;
  await assert.rejects(signIn(db, 'guarded', wrong, t), e => e.status === 401, 'unlocked after a minute; a 6th wrong one');
  await assert.rejects(signIn(db, 'guarded', ITALIAN, t + 1000), e => e.status === 429 && /2 minutes/.test(e.message), 'now locked for 2');
  t += 121_000;
  assert.equal((await signIn(db, 'guarded', ITALIAN, t)).name, 'guarded');
  for (let i = 0; i < 4; i++) await assert.rejects(signIn(db, 'guarded', wrong, t), e => e.status === 401);
  await assert.rejects(signIn(db, 'guarded', wrong, t), e => e.status === 401, 'the right one cleared the count: 5 more before a lock');
  db.close();
});

test('sessions expire after 90 days', () => {
  const db = openDb(join(dir, 'clock'));
  const acc = db.prepare("SELECT id FROM accounts WHERE name = 'guarded'").get();
  const token = startSession(db, acc.id, 0);
  assert.equal(sessionAccount(db, token, SESSION_DAYS * 86_400_000 - 1).name, 'guarded');
  assert.equal(sessionAccount(db, token, SESSION_DAYS * 86_400_000), null);
  assert.equal(sessionAccount(db, token, 0), null, 'and an expired one is deleted');
  db.close();
});

test('without a data folder, accounts are switched off, not broken', async () => {
  const s = await start({ port: 0, host: '127.0.0.1' });
  const res = await fetch(`http://127.0.0.1:${s.address().port}/api/me`);
  assert.equal(res.status, 503);
  s.close();
});
