// Games between people, by challenge link: the server keeps the game and both clocks, and checks
// every move with the variant's rules (site/js/variants), so nobody can play an illegal move or stop
// their clock. Each side has a seat key: a random token their browser keeps, of which the database
// has only a hash. A signed-in player's account also finds their seat, from any device.
//
// Clocks: each side has its own time control (base and increment). A side's clock runs only on its
// turn, and no clock runs before White's first move. After each move the mover's time is reduced by
// how long they took, then their increment is added. Running out is a loss, checked by a timer so
// the flag falls even if nobody moves (simplified: FIDE would make it a draw when the other side
// couldn't possibly checkmate).
import { randomBytes, createHash } from 'node:crypto';
import { variant } from '../site/js/variants/index.js';

export class GameError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const hash = token => createHash('sha256').update(token).digest('hex');
const other = c => (c === 'w' ? 'b' : 'w');
const COLOURS = ['w', 'b'];
// Time controls, per side: 30 seconds to 3 hours, plus 0 to 3 minutes a move
const LIMITS = { minMinutes: 0.5, maxMinutes: 180, maxIncrement: 180 };

function checkTimes(times) {
  const out = {};
  for (const c of COLOURS) {
    const t = times && times[c];
    const minutes = Number(t && t.minutes), increment = Number(t && t.increment);
    if (!(minutes >= LIMITS.minMinutes && minutes <= LIMITS.maxMinutes) || !(increment >= 0 && increment <= LIMITS.maxIncrement)) {
      throw new GameError(400, `Time controls are ${LIMITS.minMinutes * 60} seconds to ${LIMITS.maxMinutes / 60} hours, plus 0 to ${LIMITS.maxIncrement} seconds a move.`);
    }
    out[c] = { base: Math.round(minutes * 60_000), inc: Math.round(increment * 1000) };
  }
  return out;
}

export function makeGames(db, { now = () => Date.now(), changed = () => {} } = {}) {
  const timers = new Map();   // game id -> the timer that ends it when the running clock reaches 0

  const load = id => {
    const r = typeof id === 'string' && db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!r) throw new GameError(404, 'There’s no game with that link.');
    return { ...r, moves: JSON.parse(r.moves), result: r.result ? JSON.parse(r.result) : null };
  };
  const rules = g => variant(g.variant);
  const position = g => rules(g).replay(g.start, g.moves);
  const turnOf = g => rules(g).turn(position(g).states.at(-1));
  const nameOf = id => (id == null ? null : db.prepare('SELECT name FROM accounts WHERE id = ?').get(id)?.name ?? null);

  // Time left for a side right now: its stored time, less the running turn if it's its turn
  function left(g, c, t = now()) {
    let ms = g[`${c}_left`];
    if (g.status === 'playing' && g.turn_started != null && turnOf(g) === c) ms -= t - g.turn_started;
    return Math.max(0, ms);
  }

  function save(g, fields) {
    Object.assign(g, fields, { updated: now() });
    const cols = Object.keys(fields).concat('updated');
    const value = k => (k === 'moves' || k === 'result' ? (g[k] == null ? null : JSON.stringify(g[k])) : g[k]);
    db.prepare(`UPDATE games SET ${cols.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(value), g.id);
    schedule(g);
    changed(g.id);
  }

  // The timer for the running clock: when it reaches 0, the side to move loses on time
  function schedule(g) {
    clearTimeout(timers.get(g.id));
    timers.delete(g.id);
    if (g.status !== 'playing' || g.turn_started == null) return;
    const t = setTimeout(() => { try { flag(g.id); } catch { /* the game's gone */ } }, left(g, turnOf(g)) + 20);
    t.unref?.();
    timers.set(g.id, t);
  }

  function flag(id) {
    const g = load(id);
    if (g.status !== 'playing' || g.turn_started == null) return false;
    const c = turnOf(g);
    if (left(g, c) > 0) { schedule(g); return false; }
    save(g, { status: 'over', result: { winner: other(c), reason: 'time' }, [`${c}_left`]: 0, turn_started: null, draw_offer: null });
    return true;
  }

  // Which side the caller plays: by their seat key, or by their account
  function seatOf(g, seat, account) {
    if (typeof seat === 'string' && seat) {
      const h = hash(seat);
      for (const c of COLOURS) if (g[`${c}_seat`] === h) return c;
    }
    if (account) for (const c of COLOURS) if (g[`${c}_account`] === account.id) return c;
    return null;
  }

  function mustPlay(g, seat, account) {
    const c = seatOf(g, seat, account);
    if (!c) throw new GameError(403, 'You’re not playing in this game.');
    if (g.status !== 'playing') throw new GameError(409, 'This game isn’t being played.');
    return c;
  }

  // What everyone may see (the players, and later anyone watching): never the seat keys
  function view(g, you = null) {
    const t = now();
    const turn = turnOf(g);
    return {
      id: g.id, variant: g.variant, start: g.start, moves: g.moves, status: g.status, result: g.result,
      drawOffer: g.draw_offer, turn,
      players: Object.fromEntries(COLOURS.map(c => [c, { name: nameOf(g[`${c}_account`]), joined: !!g[`${c}_seat`] || g[`${c}_account`] != null }])),
      times: Object.fromEntries(COLOURS.map(c => [c, { base: g[`${c}_base`], inc: g[`${c}_inc`] }])),
      clocks: Object.fromEntries(COLOURS.map(c => [c, left(g, c, t)])),
      running: g.status === 'playing' && g.turn_started != null ? turn : null,
      serverNow: t,
      you,
    };
  }

  // Games still being played when the server starts again get their timers back
  for (const r of db.prepare("SELECT id FROM games WHERE status = 'playing'").all()) {
    try { const g = load(r.id); if (!flag(g.id)) schedule(g); } catch { /* skip a broken one */ }
  }

  return {
    get(id, seat, account) { const g = load(id); return view(g, seatOf(g, seat, account)); },

    create({ variant: variantId = 'chess', color = 'random', times, account = null }) {
      const v = variant(variantId);
      if (!v) throw new GameError(400, 'That isn’t a game this site plays.');
      if (!['w', 'b', 'random'].includes(color)) throw new GameError(400, 'Choose White, Black or random.');
      const tc = checkTimes(times);
      const side = color === 'random' ? (randomBytes(1)[0] & 1 ? 'w' : 'b') : color;
      const id = randomBytes(9).toString('base64url');   // 12 characters: not guessable
      const seat = randomBytes(24).toString('base64url');
      const t = now();
      db.prepare(`INSERT INTO games (id, variant, start, status, ${side}_seat, ${side}_account, w_base, w_inc, b_base, b_inc, w_left, b_left, created, updated)
                  VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, v.id, v.start(), hash(seat), account ? account.id : null, tc.w.base, tc.w.inc, tc.b.base, tc.b.inc, tc.w.base, tc.b.base, t, t);
      changed(id);
      return { id, seat, color: side };
    },

    join(id, seat, account = null) {
      const g = load(id);
      const already = seatOf(g, seat, account);
      if (already) return { seat: null, color: already };   // you're in it already (your other tab, or your account)
      if (g.status !== 'waiting') throw new GameError(409, 'Someone has already taken the other side of this game.');
      const open = COLOURS.find(c => !g[`${c}_seat`] && g[`${c}_account`] == null);
      const key = randomBytes(24).toString('base64url');
      save(g, { status: 'playing', [`${open}_seat`]: hash(key), [`${open}_account`]: account ? account.id : null });
      return { seat: key, color: open };
    },

    move(id, seat, account, move) {
      const g = load(id);
      const c = mustPlay(g, seat, account);
      if (flag(id)) throw new GameError(409, 'Your time ran out.');
      if (turnOf(g) !== c) throw new GameError(409, 'It’s not your turn.');
      const played = rules(g).replay(g.start, [...g.moves, move]);
      if (played.error) throw new GameError(400, 'That isn’t a legal move.');
      const t = now();
      // The mover's time: less this turn (once clocks run), plus their increment
      const mine = g.turn_started == null ? g[`${c}_left`] : g[`${c}_left`] - (t - g.turn_started) + g[`${c}_inc`];
      const over = played.result;
      save(g, {
        moves: [...g.moves, move], [`${c}_left`]: mine, draw_offer: null,
        turn_started: over ? null : t,            // after any move the other side's clock runs (White's first starts it)
        ...(over && { status: 'over', result: over }),
      });
      return view(g, c);
    },

    resign(id, seat, account) {
      const g = load(id);
      const c = mustPlay(g, seat, account);
      if (flag(id)) return view(load(id), c);
      const fields = { status: 'over', result: { winner: other(c), reason: 'resign' }, draw_offer: null };
      if (g.turn_started != null) fields[`${turnOf(g)}_left`] = left(g, turnOf(g));   // the clock stops where it was
      save(g, { ...fields, turn_started: null });
      return view(g, c);
    },

    // Offering a draw; offering when the other side already has is accepting
    offerDraw(id, seat, account) {
      const g = load(id);
      const c = mustPlay(g, seat, account);
      if (g.draw_offer === other(c)) {
        const fields = { status: 'over', result: { winner: null, reason: 'agreement' }, draw_offer: null };
        if (g.turn_started != null) fields[`${turnOf(g)}_left`] = left(g, turnOf(g));
        save(g, { ...fields, turn_started: null });
      } else if (!g.draw_offer) save(g, { draw_offer: c });
      return view(g, c);
    },

    declineDraw(id, seat, account) {
      const g = load(id);
      const c = mustPlay(g, seat, account);
      if (g.draw_offer === other(c)) save(g, { draw_offer: null });
      return view(g, c);
    },

    // Calling it off: a game nobody has joined, or one where both sides haven't moved yet
    abort(id, seat, account) {
      const g = load(id);
      const c = seatOf(g, seat, account);
      if (!c) throw new GameError(403, 'You’re not playing in this game.');
      if (!(g.status === 'waiting' || (g.status === 'playing' && g.moves.length < 2))) {
        throw new GameError(409, 'A game can only be called off before both sides have moved.');
      }
      save(g, { status: 'aborted', result: { winner: null, reason: 'aborted' }, turn_started: null, draw_offer: null });
      return view(g, c);
    },

    flag,
    stop() { for (const t of timers.values()) clearTimeout(t); timers.clear(); },
  };
}
