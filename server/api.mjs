// The /api/ routes: accounts and each account's current game.
//   POST /api/signup   { name, secret: { variant, moves } }   -> 201 { name }, and the session cookie
//   POST /api/signin   { name, secret }                       -> { name }, and the session cookie
//   POST /api/signout                                         -> { ok }
//   GET  /api/me                                              -> { name } (null when signed out)
//   GET  /api/game                                            -> { data, updated } (data null if none)
//   PUT  /api/game     { data }                               -> { updated }
// Games by challenge link (games.mjs). A seat key comes in the body, or the X-Seat header for GETs:
//   POST /api/games    { variant, color, times, listed, evalBar } -> 201 { id, seat, color }  (listed: in Live games;
//                                                               evalBar: the evaluation bar shown to everyone during play)
//   GET  /api/lobby, and /api/lobby/events (SSE)                -> { open, live }: Live games
//   GET  /api/games/ID                                        -> the game ("you": your side, if any)
//   GET  /api/games/ID/events                                 -> the game, then again on every change (SSE)
//   POST /api/games/ID/join                                   -> { seat, color }
//   POST /api/games/ID/move { seat, move }, and /resign, /draw (offer or accept), /decline, /abort { seat }
//   POST /api/games/ID/rematch { seat, variant, color, times } -> 201 { id, seat, color, variant }: a new
//        game for the other player of finished game ID; they join it with /join { proof } (their seat
//        key in ID), or decline with /refuse { proof }
// Anything that changes something must be JSON with the header "X-Requested-With: chess", from this
// site's own pages (Origin), so another site can't make a visitor's browser do it.
import { HEADERS } from './headers.mjs';
import { AccountError, signUp, signIn, startSession, sessionAccount, endSession, SESSION_DAYS } from './accounts.mjs';
import { GameError, makeGames } from './games.mjs';

const COOKIE = 'chess_session';
const MAX_BODY = 256 * 1024;

function reply(res, status, body, extra = {}) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(([k, v]) => k && v));

function sessionCookie(token, secure, maxAge = SESSION_DAYS * 86400) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function readJson(req) {
  return new Promise((ok, fail) => {
    let size = 0, body = '';
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) {
        // Stop keeping it, but let the rest arrive and be thrown away, so the visitor gets the answer
        // (cutting the connection here would lose it); the reply then closes the connection
        req.removeAllListeners('data');
        req.resume();
        fail(new AccountError(413, 'That’s too much to send.'));
        return;
      }
      body += d;
    });
    req.on('end', () => { try { ok(body ? JSON.parse(body) : {}); } catch { fail(new AccountError(400, 'That wasn’t valid JSON.')); } });
    req.on('error', fail);
  });
}

// Requests per visitor (by address; behind the tunnel Cloudflare passes the visitor's own), counted
// in memory over a sliding window. A restart forgets them, which is fine for this.
class Limit {
  constructor(max, minutes) { this.max = max; this.ms = minutes * 60_000; this.seen = new Map(); }
  take(key, now = Date.now()) {
    const recent = (this.seen.get(key) || []).filter(t => t > now - this.ms);
    if (recent.length >= this.max) { this.seen.set(key, recent); return false; }
    recent.push(now);
    this.seen.set(key, recent);
    if (this.seen.size > 10_000) for (const [k, v] of this.seen) if (!v.some(t => t > now - this.ms)) this.seen.delete(k);
    return true;
  }
}

export function makeApi({ db, secureCookies = true, now = () => Date.now() }) {
  const limits = { signin: new Limit(30, 15), signup: new Limit(5, 60), games: new Limit(30, 60) };

  // Everyone with a game open gets it again, whole, whenever it changes: Server-Sent Events, a
  // response the browser keeps open (EventSource; it reconnects by itself). A comment line every
  // 25 s keeps quiet connections from being closed on the way (Cloudflare drops idle ones).
  const watchers = new Map();   // game id -> the responses watching it
  const games = db ? makeGames(db, { now, changed: id => tell(id) }) : null;
  function tell(id) {
    lobbyChanged();
    const open = watchers.get(id);
    if (!open || !open.size) return;
    let data;
    try { data = JSON.stringify(games.get(id)); } catch { return; }
    for (const res of open) res.write(`event: game\ndata: ${data}\n\n`);
  }
  const STREAM_HEAD = { ...HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' };
  function watch(req, res, id) {
    const first = JSON.stringify(games.get(id));   // a 404 here, before the stream starts, if there's no such game
    res.writeHead(200, STREAM_HEAD);
    res.write(`retry: 3000\nevent: game\ndata: ${first}\n\n`);
    if (!watchers.has(id)) watchers.set(id, new Set());
    watchers.get(id).add(res);
    lobbyChanged();   // a waiting game's maker is here: it can be listed
    req.on('close', () => {
      const open = watchers.get(id);
      open?.delete(res);
      if (open && !open.size) watchers.delete(id);
      lobbyChanged();   // and when they've gone, it can't
    });
  }

  // Live games: the list, to everyone who has it open, again on every change, at most twice a second
  const lobbyWatchers = new Set();
  const present = id => (watchers.get(id)?.size || 0) > 0;
  let lobbyTimer = null;
  function lobbyChanged() {
    if (!lobbyWatchers.size || lobbyTimer) return;
    lobbyTimer = setTimeout(() => {
      lobbyTimer = null;
      const data = JSON.stringify(games.lobby(present));
      for (const res of lobbyWatchers) res.write(`event: lobby\ndata: ${data}\n\n`);
    }, 500);
    lobbyTimer.unref?.();
  }
  function watchLobby(req, res) {
    res.writeHead(200, STREAM_HEAD);
    res.write(`retry: 3000\nevent: lobby\ndata: ${JSON.stringify(games.lobby(present))}\n\n`);
    lobbyWatchers.add(res);
    req.on('close', () => lobbyWatchers.delete(res));
  }
  const beat = setInterval(() => {
    for (const res of [...[...watchers.values()].flatMap(open => [...open]), ...lobbyWatchers]) res.write(': still here\n\n');
  }, 25_000);
  beat.unref?.();
  const who = req => req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';

  async function api(req, res, path) {
    try {
      if (!db) throw new AccountError(503, 'Accounts aren’t available on this server.');
      const changes = req.method !== 'GET' && req.method !== 'HEAD';
      if (changes) {
        if (req.headers['x-requested-with'] !== 'chess' || !/^application\/json\b/.test(req.headers['content-type'] || '')) {
          throw new AccountError(403, 'Requests must come from the chess site’s own pages.');
        }
        const origin = req.headers.origin;
        let from = null;
        try { from = origin && new URL(origin).host; } catch { /* "null" or junk: not this site */ }
        if (origin && from !== req.headers.host) throw new AccountError(403, 'Requests must come from the chess site’s own pages.');
      }
      const token = cookies(req)[COOKIE];
      const me = token ? sessionAccount(db, token, now()) : null;

      if (path === '/api/me' && req.method === 'GET') return reply(res, 200, { name: me ? me.name : null });

      if (path === '/api/signup' && req.method === 'POST') {
        if (!limits.signup.take(who(req), now())) throw new AccountError(429, 'Too many new accounts from here. Try again later.');
        const body = await readJson(req);
        const acc = await signUp(db, body.name, body.secret, now());
        return reply(res, 201, { name: acc.name }, { 'Set-Cookie': sessionCookie(startSession(db, acc.id, now()), secureCookies) });
      }
      if (path === '/api/signin' && req.method === 'POST') {
        if (!limits.signin.take(who(req), now())) throw new AccountError(429, 'Too many tries from here. Try again in a few minutes.');
        const body = await readJson(req);
        const acc = await signIn(db, body.name, body.secret, now());
        return reply(res, 200, { name: acc.name }, { 'Set-Cookie': sessionCookie(startSession(db, acc.id, now()), secureCookies) });
      }
      if (path === '/api/signout' && req.method === 'POST') {
        if (token) endSession(db, token);
        return reply(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', secureCookies, 0) });
      }

      if (path === '/api/game') {
        if (!me) throw new AccountError(401, 'Sign in first.');
        if (req.method === 'GET') {
          const row = db.prepare('SELECT data, updated FROM current_games WHERE account_id = ?').get(me.id);
          return reply(res, 200, row ? { data: JSON.parse(row.data), updated: row.updated } : { data: null, updated: null });
        }
        if (req.method === 'PUT') {
          const { data } = await readJson(req);
          if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.pgn !== 'string') throw new AccountError(400, 'That isn’t a saved game.');
          const updated = now();
          db.prepare('INSERT INTO current_games (account_id, data, updated) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, updated = excluded.updated')
            .run(me.id, JSON.stringify(data), updated);
          return reply(res, 200, { updated });
        }
      }
      if (path === '/api/lobby' && req.method === 'GET') return reply(res, 200, games.lobby(present));
      if (path === '/api/lobby/events' && req.method === 'GET') return watchLobby(req, res);
      const g = path.match(/^\/api\/games(?:\/([\w-]{1,20})(?:\/(events|join|move|resign|draw|decline|abort|rematch|refuse))?)?$/);
      if (g) {
        const [, id, action] = g;
        if (!id && req.method === 'POST') {
          if (!limits.games.take(who(req), now())) throw new AccountError(429, 'Too many new games from here. Try again later.');
          const body = await readJson(req);
          return reply(res, 201, games.create({ variant: body.variant, color: body.color, times: body.times, account: me, listed: body.listed === true, evalBar: body.evalBar === true }));
        }
        if (id && !action && req.method === 'GET') return reply(res, 200, games.get(id, req.headers['x-seat'], me));
        if (id && action === 'events' && req.method === 'GET') return watch(req, res, id);
        if (id && action && req.method === 'POST') {
          if (action === 'rematch' && !limits.games.take(who(req), now())) throw new AccountError(429, 'Too many new games from here. Try again later.');
          const body = await readJson(req);
          const act = { join: () => games.join(id, body.seat, me, body.proof), move: () => games.move(id, body.seat, me, body.move),
            resign: () => games.resign(id, body.seat, me), draw: () => games.offerDraw(id, body.seat, me),
            decline: () => games.declineDraw(id, body.seat, me), abort: () => games.abort(id, body.seat, me),
            rematch: () => games.rematch(id, body.seat, me, { variant: body.variant, color: body.color, times: body.times, evalBar: body.evalBar === true }),
            refuse: () => games.refuse(id, body.proof, me) }[action];
          return reply(res, action === 'rematch' ? 201 : 200, act());
        }
      }
      throw new AccountError(404, 'Not found');
    } catch (e) {
      if (e instanceof AccountError || e instanceof GameError) return reply(res, e.status, { error: e.message }, e.status === 413 ? { Connection: 'close' } : {});
      console.error(e);
      return reply(res, 500, { error: 'Something went wrong on the server.' });
    }
  }
  api.stop = () => {
    clearInterval(beat); clearTimeout(lobbyTimer); games?.stop();
    for (const open of watchers.values()) for (const res of open) res.end();
    for (const res of lobbyWatchers) res.end();
    watchers.clear(); lobbyWatchers.clear();
  };
  return api;
}
