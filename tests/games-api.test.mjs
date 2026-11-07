// The game routes over HTTP, and the live stream (Server-Sent Events) that sends every change
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/server.mjs';

const dir = mkdtempSync(join(tmpdir(), 'chess-games-api-'));
let server, base, ip = 0;
before(async () => { server = await start({ port: 0, host: '127.0.0.1', dataDir: dir, secureCookies: false }); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => {
  const closed = new Promise(r => server.close(r));
  server.closeAllConnections();
  await closed;
  rmSync(dir, { recursive: true, force: true });
});

const post = async (path, body, headers = {}) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'chess', 'CF-Connecting-IP': `10.1.0.${++ip}`, ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const get = async (path, headers = {}) => { const res = await fetch(base + path, { headers }); return { status: res.status, body: await res.json() }; };
const TIMES = { w: { minutes: 5, increment: 3 }, b: { minutes: 5, increment: 3 } };

// Reads a Server-Sent Events stream: next() resolves with the next "game" event's data
function stream(id) {
  const ctrl = new AbortController();
  const queue = [], waiting = [];
  const ready = fetch(`${base}/api/games/${id}/events`, { signal: ctrl.signal }).then(async res => {
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = block.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
            if (/^event: game$/m.test(block) && data) { const g = JSON.parse(data); waiting.length ? waiting.shift()(g) : queue.push(g); }
          }
        }
      } catch { /* closed */ }
    })();
    return res;
  });
  return {
    ready,
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise(r => waiting.push(r))),
    close: () => ctrl.abort(),
  };
}

test('make a game, join it, play, and watch it all arrive on the stream', async () => {
  const made = await post('/api/games', { color: 'w', times: TIMES });
  assert.equal(made.status, 201);
  assert.equal(made.body.color, 'w');
  const { id, seat: w } = made.body;
  const s = stream(id);
  const res = await s.ready;
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await s.next()).status, 'waiting', 'the game straight away');

  const joined = await post(`/api/games/${id}/join`, {});
  assert.equal(joined.status, 200);
  const b = joined.body.seat;
  assert.equal((await s.next()).status, 'playing', 'the join arrives');

  assert.equal((await post(`/api/games/${id}/move`, { seat: w, move: 'e2e4' })).status, 200);
  const afterMove = await s.next();
  assert.deepEqual(afterMove.moves, ['e2e4']);
  assert.equal(afterMove.running, 'b');
  assert.equal(afterMove.you, null, 'the stream is the same for everyone');
  assert.ok(!JSON.stringify(afterMove).includes(w) && !JSON.stringify(afterMove).includes(b), 'no seat keys on the stream');

  assert.equal((await post(`/api/games/${id}/move`, { seat: w, move: 'd2d4' })).status, 409, 'not your turn');
  assert.equal((await post(`/api/games/${id}/move`, { seat: b, move: 'e7e4' })).status, 400, 'not legal');
  await post(`/api/games/${id}/resign`, { seat: b });
  assert.deepEqual((await s.next()).result, { winner: 'w', reason: 'resign' });
  s.close();
});

test('your side, from your seat key', async () => {
  const { body: { id, seat } } = await post('/api/games', { color: 'b', times: TIMES });
  assert.equal((await get(`/api/games/${id}`, { 'X-Seat': seat })).body.you, 'b');
  assert.equal((await get(`/api/games/${id}`)).body.you, null, 'a watcher');
});

test('draw offers and calling off, through the routes', async () => {
  const { body: { id, seat: w } } = await post('/api/games', { color: 'w', times: TIMES });
  const { body: { seat: b } } = await post(`/api/games/${id}/join`, {});
  assert.equal((await post(`/api/games/${id}/abort`, { seat: b })).body.status, 'aborted');
  const { body: g2 } = await post('/api/games', { color: 'w', times: TIMES });
  const { body: { seat: b2 } } = await post(`/api/games/${g2.id}/join`, {});
  await post(`/api/games/${g2.id}/draw`, { seat: g2.seat });
  assert.equal((await post(`/api/games/${g2.id}/decline`, { seat: b2 })).body.drawOffer, null);
  await post(`/api/games/${g2.id}/draw`, { seat: b2 });
  assert.deepEqual((await post(`/api/games/${g2.id}/draw`, { seat: g2.seat })).body.result, { winner: null, reason: 'agreement' });
  assert.ok(w);
});

test('unknown games, bad settings and forged requests', async () => {
  assert.equal((await get('/api/games/nosuchgame12')).status, 404);
  const events = await fetch(`${base}/api/games/nosuchgame12/events`);
  assert.equal(events.status, 404, 'no stream for a game that isn’t there');
  assert.equal((await post('/api/games', { color: 'w', times: { w: { minutes: 0, increment: 0 }, b: { minutes: 5, increment: 0 } } })).status, 400);
  assert.equal((await post('/api/games', { color: 'w', times: TIMES }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await get('/api/games/bad!id')).status, 404, 'odd characters in the id');
});

test('thirty new games an hour from one address', async () => {
  const headers = { 'CF-Connecting-IP': '10.9.9.9' };
  for (let i = 0; i < 30; i++) assert.equal((await post('/api/games', { color: 'w', times: TIMES }, headers)).status, 201);
  assert.equal((await post('/api/games', { color: 'w', times: TIMES }, headers)).status, 429);
});
