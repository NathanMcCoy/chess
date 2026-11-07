// Games by challenge link (server/games.mjs), with a clock the test controls
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.mjs';
import { makeGames } from '../server/games.mjs';
import { signUp } from '../server/accounts.mjs';

const dir = mkdtempSync(join(tmpdir(), 'chess-games-'));
const dbs = [], all = [];
after(() => { all.forEach(g => g.stop()); dbs.forEach(d => d.close()); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function setup() {
  const db = openDb(join(dir, `db${++n}`));
  dbs.push(db);
  const clock = { t: 1_000_000 };
  const changes = [];
  const games = makeGames(db, { now: () => clock.t, changed: id => changes.push(id) });
  all.push(games);
  return { db, games, clock, changes };
}
const TEN_FIVE = { w: { minutes: 10, increment: 5 }, b: { minutes: 10, increment: 5 } };
const err = (status, re) => e => e.status === status && (!re || re.test(e.message));

// A game with both sides seated: White is the creator
function started(times = TEN_FIVE) {
  const s = setup();
  const made = s.games.create({ color: 'w', times });
  const joined = s.games.join(made.id, null);
  return { ...s, id: made.id, w: made.seat, b: joined.seat };
}

test('making a game checks its settings', () => {
  const { games } = setup();
  assert.throws(() => games.create({ color: 'w', times: { w: { minutes: 0.1, increment: 0 }, b: { minutes: 5, increment: 0 } } }), err(400, /30 seconds/));
  assert.throws(() => games.create({ color: 'w', times: { w: { minutes: 5, increment: 999 }, b: { minutes: 5, increment: 0 } } }), err(400));
  assert.throws(() => games.create({ color: 'w', times: { w: { minutes: 5, increment: 0 } } }), err(400), 'both sides need one');
  assert.throws(() => games.create({ color: 'purple', times: TEN_FIVE }), err(400));
  assert.throws(() => games.create({ variant: 'checkers', color: 'w', times: TEN_FIVE }), err(400));
});

test('a new game waits for the friend, with nobody’s clock running', () => {
  const { games, changes } = setup();
  const made = games.create({ color: 'b', times: TEN_FIVE });
  assert.match(made.id, /^[\w-]{12}$/);
  assert.equal(made.color, 'b');
  const v = games.get(made.id, made.seat);
  assert.equal(v.status, 'waiting');
  assert.equal(v.you, 'b');
  assert.deepEqual(v.players, { w: { name: null, joined: false }, b: { name: null, joined: true } });
  assert.deepEqual(v.clocks, { w: 600_000, b: 600_000 });
  assert.equal(v.running, null);
  assert.equal(v.variant, 'chess');
  assert.ok(!JSON.stringify(v).includes(made.seat) && !('w_seat' in v), 'no seat keys in what anyone can see');
  assert.deepEqual(changes, [made.id]);
  assert.equal(games.get(made.id, 'someone-else').you, null, 'a watcher');
  assert.throws(() => games.get('nope'), err(404));
});

test('random colour picks one, and both happen', () => {
  const { games } = setup();
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(games.create({ times: TEN_FIVE }).color);
  assert.deepEqual([...seen].sort(), ['b', 'w']);
});

test('joining takes the other side, once', () => {
  const { games } = setup();
  const made = games.create({ color: 'w', times: TEN_FIVE });
  const j = games.join(made.id, null);
  assert.equal(j.color, 'b');
  assert.equal(games.get(made.id).status, 'playing');
  assert.throws(() => games.join(made.id, null), err(409), 'a third person can’t');
  assert.deepEqual(games.join(made.id, made.seat), { seat: null, color: 'w' }, 'the creator opening the link again is already in it');
});

test('turns, seats and legal moves are enforced', () => {
  const { games, id, w, b } = started();
  assert.throws(() => games.move(id, b, null, 'e7e5'), err(409, /not your turn/));
  assert.throws(() => games.move(id, 'stranger', null, 'e2e4'), err(403));
  assert.throws(() => games.move(id, w, null, 'e2e5'), err(400, /legal/));
  assert.throws(() => games.move(id, w, null, 'Nf3'), err(400), 'moves are in UCI');
  assert.deepEqual(games.move(id, w, null, 'e2e4').moves, ['e2e4']);
});

test('clocks: none before White’s first move, then each side’s own, with its increment', () => {
  // White 3+2, Black 10+5
  const { games, clock, id, w, b } = started({ w: { minutes: 3, increment: 2 }, b: { minutes: 10, increment: 5 } });
  clock.t += 30_000;   // White thinks for 30 s before the first move: no clock yet
  let v = games.move(id, w, null, 'e2e4');
  assert.deepEqual(v.clocks, { w: 180_000, b: 600_000 }, 'no time used, and no increment, before clocks run');
  assert.equal(v.running, 'b');
  clock.t += 4_000;
  assert.equal(games.get(id).clocks.b, 596_000, 'Black’s clock is running');
  v = games.move(id, b, null, 'e7e5');
  assert.equal(v.clocks.b, 600_000 - 4_000 + 5_000, 'Black: less 4 s, plus 5 s');
  assert.equal(v.running, 'w');
  clock.t += 10_000;
  v = games.move(id, w, null, 'g1f3');
  assert.equal(v.clocks.w, 180_000 - 10_000 + 2_000, 'White: less 10 s, plus 2 s');
});

test('running out of time loses, even if nobody moves', () => {
  const { games, clock, id, w, b } = started({ w: { minutes: 1, increment: 0 }, b: { minutes: 1, increment: 0 } });
  games.move(id, w, null, 'e2e4');
  clock.t += 59_000;
  assert.equal(games.flag(id), false, 'a second left');
  clock.t += 2_000;
  assert.equal(games.flag(id), true);
  const v = games.get(id);
  assert.equal(v.status, 'over');
  assert.deepEqual(v.result, { winner: 'w', reason: 'time' });
  assert.equal(v.clocks.b, 0);
  assert.equal(v.running, null);
  assert.throws(() => games.move(id, b, null, 'e7e5'), err(409));
});

test('a move after the flag has fallen (but before the timer saw it) is refused', () => {
  const { games, clock, id, w, b } = started({ w: { minutes: 1, increment: 0 }, b: { minutes: 1, increment: 0 } });
  games.move(id, w, null, 'e2e4');
  clock.t += 61_000;
  assert.throws(() => games.move(id, b, null, 'e7e5'), err(409, /time ran out/));
  assert.deepEqual(games.get(id).result, { winner: 'w', reason: 'time' });
});

test('checkmate ends it', () => {
  const { games, id, w, b } = started();
  games.move(id, w, null, 'f2f3');
  games.move(id, b, null, 'e7e5');
  games.move(id, w, null, 'g2g4');
  const v = games.move(id, b, null, 'd8h4');
  assert.equal(v.status, 'over');
  assert.deepEqual(v.result, { winner: 'b', reason: 'checkmate' });
  assert.equal(v.running, null, 'the clocks stop');
});

test('resigning gives the other side the game, and stops the clock where it was', () => {
  const { games, clock, id, w, b } = started();
  games.move(id, w, null, 'e2e4');
  clock.t += 7_000;
  const v = games.resign(id, b, null);
  assert.deepEqual(v.result, { winner: 'w', reason: 'resign' });
  clock.t += 60_000;
  assert.equal(games.get(id).clocks.b, 593_000, 'not still running');
});

test('draws: offered, declined, offered again and accepted', () => {
  const { games, id, w, b } = started();
  games.move(id, w, null, 'e2e4');
  assert.equal(games.offerDraw(id, w, null).drawOffer, 'w');
  assert.equal(games.declineDraw(id, b, null).drawOffer, null);
  games.offerDraw(id, w, null);
  games.move(id, b, null, 'e7e5');
  assert.equal(games.get(id).drawOffer, null, 'a move answers an offer with no');
  games.offerDraw(id, b, null);
  const v = games.offerDraw(id, w, null);
  assert.deepEqual(v.result, { winner: null, reason: 'agreement' });
});

test('calling a game off: only before both sides have moved', () => {
  const a = started();
  a.games.move(a.id, a.w, null, 'e2e4');
  assert.equal(a.games.abort(a.id, a.b, null).status, 'aborted');
  const c = started();
  c.games.move(c.id, c.w, null, 'e2e4');
  c.games.move(c.id, c.b, null, 'e7e5');
  assert.throws(() => c.games.abort(c.id, c.w, null), err(409));
  const { games } = setup();
  const waiting = games.create({ color: 'w', times: TEN_FIVE });
  assert.equal(games.abort(waiting.id, waiting.seat, null).status, 'aborted', 'a game nobody joined');
  assert.throws(() => games.abort(waiting.id, 'stranger', null), err(403));
});

test('a signed-in player’s account finds their seat from another device, and their name shows', async () => {
  const { db, games } = setup();
  const acc = await signUp(db, 'Nathan', { variant: 'chess', moves: ['e2e4'] });
  const made = games.create({ color: 'w', times: TEN_FIVE, account: acc });
  games.join(made.id, null);
  assert.equal(games.get(made.id, null, acc).you, 'w', 'no seat key needed');
  assert.deepEqual(games.move(made.id, null, acc, 'd2d4').moves, ['d2d4']);
  assert.equal(games.get(made.id).players.w.name, 'Nathan');
  assert.equal(games.get(made.id).players.b.name, null, 'a guest has no name');
});

test('a flag that fell while the server was down is seen when it starts again', () => {
  const { db, games, clock, id, w } = (() => { const s = started({ w: { minutes: 1, increment: 0 }, b: { minutes: 1, increment: 0 } }); return s; })();
  games.move(id, w, null, 'e2e4');
  games.stop();
  clock.t += 120_000;
  const again = makeGames(db, { now: () => clock.t });
  all.push(again);
  assert.deepEqual(again.get(id).result, { winner: 'w', reason: 'time' });
});
