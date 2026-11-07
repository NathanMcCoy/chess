// Accounts: a name, and a secret opening (a few moves played on the board) instead of a password.
// Only a slow hash of the opening is stored. The opening is checked move by move with the variant's
// rules first, so it's always a real sequence of legal moves.
import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { variant } from '../site/js/variants/index.js';

const scryptAsync = promisify(scrypt);
// scrypt is slow on purpose: about 50 ms and 16 MB per try, so guessing is expensive even for
// someone with a copy of the database
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_PLIES = 40;
export const SESSION_DAYS = 90;
const RESERVED = new Set(['admin', 'administrator', 'stockfish', 'guest', 'anonymous', 'system', 'root', 'moderator', 'pacificfish', 'null', 'undefined']);

export class AccountError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function checkName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{3,20}$/.test(name)) {
    throw new AccountError(400, 'Names are 3 to 20 letters, numbers, - or _.');
  }
  if (RESERVED.has(name.toLowerCase())) throw new AccountError(400, 'That name is reserved. Try another.');
  return name;
}

// The opening as one string to hash: its variant and its moves, after checking they're legal
export function secretText(secret) {
  const rules = secret && variant(secret.variant);
  if (!rules || !Array.isArray(secret.moves)) throw new AccountError(400, 'Play your opening on the board.');
  if (!secret.moves.length) throw new AccountError(400, 'Play at least one move.');
  if (secret.moves.length > MAX_PLIES) throw new AccountError(400, `Openings can be up to ${MAX_PLIES} moves (both sides together).`);
  const played = rules.replay(rules.start(), secret.moves);
  if (played.error) throw new AccountError(400, 'That isn’t a sequence of legal moves.');
  return `${rules.id}\n${secret.moves.join(' ')}`;
}

const hashSecret = (text, salt) => scryptAsync(text, salt, 32, SCRYPT);
const tokenHash = token => createHash('sha256').update(token).digest('hex');

export async function signUp(db, name, secret, now = Date.now()) {
  checkName(name);
  const text = secretText(secret);
  if (db.prepare('SELECT 1 FROM accounts WHERE name = ?').get(name)) throw new AccountError(409, 'That name is taken. Try another.');
  const salt = randomBytes(16);
  const hash = await hashSecret(text, salt);
  try {
    const r = db.prepare('INSERT INTO accounts (name, secret_variant, secret_salt, secret_hash, created) VALUES (?, ?, ?, ?, ?)')
      .run(name, secret.variant, salt, hash, now);
    return { id: Number(r.lastInsertRowid), name };
  } catch (e) {
    // two sign-ups for the same name at once: the second loses here
    if (/UNIQUE/.test(e.message)) throw new AccountError(409, 'That name is taken. Try another.');
    throw e;
  }
}

// Wrong openings lock the account for a while: after 5 in a row, 1 minute, doubling each time up to
// an hour. A right one clears the count. Whoever is guessing learns nothing from the answer beyond
// "no": the same words for a wrong name or a wrong opening.
const lockFor = fails => (fails < 5 ? 0 : Math.min(60, 2 ** (fails - 5)) * 60_000);
const NO_MATCH = 'That name and opening don’t match.';

export async function signIn(db, name, secret, now = Date.now()) {
  if (typeof name !== 'string' || name.length > 40) throw new AccountError(401, NO_MATCH);
  let text;
  try { text = secretText(secret); } catch { throw new AccountError(401, NO_MATCH); }
  const acc = db.prepare('SELECT * FROM accounts WHERE name = ?').get(name);
  if (!acc) {
    await hashSecret(text, randomBytes(16));   // the same delay as a real check, so timing doesn't tell which names exist
    throw new AccountError(401, NO_MATCH);
  }
  if (acc.locked_until > now) {
    const minutes = Math.ceil((acc.locked_until - now) / 60_000);
    throw new AccountError(429, `Too many wrong openings. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
  const hash = await hashSecret(text, Buffer.from(acc.secret_salt));
  if (!timingSafeEqual(hash, Buffer.from(acc.secret_hash))) {
    const fails = acc.fails + 1;
    db.prepare('UPDATE accounts SET fails = ?, locked_until = ? WHERE id = ?').run(fails, lockFor(fails) ? now + lockFor(fails) : 0, acc.id);
    throw new AccountError(401, NO_MATCH);
  }
  db.prepare('UPDATE accounts SET fails = 0, locked_until = 0 WHERE id = ?').run(acc.id);
  return { id: acc.id, name: acc.name };
}

// Sessions: a random token in the visitor's cookie; the database keeps only its hash
export function startSession(db, accountId, now = Date.now()) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, account_id, created, expires) VALUES (?, ?, ?, ?)')
    .run(tokenHash(token), accountId, now, now + SESSION_DAYS * 86_400_000);
  return token;
}

export function sessionAccount(db, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 100) return null;
  const row = db.prepare('SELECT a.id, a.name, s.expires FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?').get(tokenHash(token));
  if (!row) return null;
  if (row.expires <= now) { endSession(db, token); return null; }
  return { id: row.id, name: row.name };
}

export function endSession(db, token) {
  if (typeof token === 'string') db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}
