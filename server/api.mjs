// The /api/ routes: accounts and each account's current game.
//   POST /api/signup   { name, secret: { variant, moves } }   -> 201 { name }, and the session cookie
//   POST /api/signin   { name, secret }                       -> { name }, and the session cookie
//   POST /api/signout                                         -> { ok }
//   GET  /api/me                                              -> { name } (null when signed out)
//   GET  /api/game                                            -> { data, updated } (data null if none)
//   PUT  /api/game     { data }                               -> { updated }
// Anything that changes something must be JSON with the header "X-Requested-With: chess", from this
// site's own pages (Origin), so another site can't make a visitor's browser do it.
import { HEADERS } from './headers.mjs';
import { AccountError, signUp, signIn, startSession, sessionAccount, endSession, SESSION_DAYS } from './accounts.mjs';

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
  const limits = { signin: new Limit(30, 15), signup: new Limit(5, 60) };
  const who = req => req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';

  return async function api(req, res, path) {
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
      throw new AccountError(404, 'Not found');
    } catch (e) {
      if (e instanceof AccountError) return reply(res, e.status, { error: e.message }, e.status === 413 ? { Connection: 'close' } : {});
      console.error(e);
      return reply(res, 500, { error: 'Something went wrong on the server.' });
    }
  };
}
