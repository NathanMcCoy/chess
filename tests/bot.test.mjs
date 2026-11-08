// The site's own bot (site/js/bot/bot.js) and the variants' `engine` it plays through. No browser.
// Searches are limited by depth, not time, so a busy machine can't change the answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import hex from '../site/js/variants/hex.js';
import chess from '../site/js/variants/chess.js';
import { chooseMove, evaluate, startingWeights, size, usable, TYPES } from '../site/js/bot/bot.js';

// A hex position from { cell: piece } (uppercase White), as in hex.test.mjs
const { files, cells } = hex.geometry;
const len = f => cells.filter(c => c.file === f).length;
function hexPosition(pieces, turn = 'w') {
  const layout = [...files].map(f => {
    let out = '', empty = 0;
    for (let rank = 1; rank <= len(f); rank++) {
      const p = pieces[f + rank];
      if (!p) { empty++; continue; }
      if (empty) { out += empty; empty = 0; }
      out += p;
    }
    return out + (empty || '');
  }).join('/');
  return `${layout} ${turn} - 0 1`;
}
const weights = v => startingWeights(v.id, v.engine.cells, v.engine.extraNames);
// Weights with every number random: anything true for these is true whatever training makes
function randomWeights(v, seed = 1) {
  const w = weights(v);
  let x = seed;
  const r = () => { x = (x * 16807) % 2147483647; return (x / 2147483647) * 2 - 1; };
  w.values = w.values.map(r);
  w.endgame = w.endgame.map(r);
  w.extras.middle = w.extras.middle.map(r);
  w.extras.end = w.extras.end.map(r);
  return w;
}
// A game of `n` moves, each picked by a fixed sequence from the legal ones
function someGame(v, n) {
  const moves = [];
  let x = 7;
  for (let i = 0; i < n; i++) {
    const r = v.replay(v.start(), moves);
    if (r.result) break;
    const legal = v.legal(r.states.at(-1));
    x = (x * 48271) % 2147483647;
    moves.push(legal[x % legal.length]);
  }
  return moves;
}

for (const v of [hex, chess]) {
  const e = v.engine;
  test(`${v.id}: the engine's moves and positions agree with legal() and replay(), over a whole game`, () => {
    const moves = someGame(v, 60);
    const { states } = v.replay(v.start(), moves);
    let pos = e.from(v.start());
    // The engine's key may be written differently from key(), but must match exactly when it does
    const toRule = new Map(), toEngine = new Map();
    for (let i = 0; i <= moves.length; i++) {
      const k = e.key(pos), rk = v.key(states[i]);
      assert.equal(toRule.get(k) ?? rk, rk, `move ${i}: one engine key for two positions`);
      assert.equal(toEngine.get(rk) ?? k, k, `move ${i}: two engine keys for one position`);
      toRule.set(k, rk); toEngine.set(rk, k);
      if (i === moves.length) break;
      assert.deepEqual(e.moves(pos).map(e.text).sort(), v.legal(states[i]).sort(), `move ${i}`);
      pos = e.play(pos, e.moves(pos).find(m => e.text(m) === moves[i]));
      assert.equal(e.state(pos), states[i + 1], `after move ${i}`);
    }
  });

  test(`${v.id}: mirror() swaps the sides: twice is no change, and the start is the same for both`, () => {
    for (let i = 0; i < e.cells; i++) assert.equal(e.mirror(e.mirror(i)), i);
    const start = e.pieces(e.from(v.start()));
    const white = start.filter(p => p[2] === 'w').map(([t, i]) => `${t}${i}`).sort();
    const black = start.filter(p => p[2] === 'b').map(([t, i]) => `${t}${e.mirror(i)}`).sort();
    assert.deepEqual(white, black);
  });

  test(`${v.id}: the start is even whatever the weights: every extra is 0 there, and the phase 1`, () => {
    const w = randomWeights(v);
    assert.equal(w.values.length, size(e.cells));
    assert.ok(Math.abs(evaluate(e, e.from(v.start()), w)) < 1e-9);
    assert.deepEqual(e.extras(e.from(v.start())), e.extraNames.map(() => 0));
    assert.equal(e.phase(e.from(v.start())), 1);
  });

  test(`${v.id}: a version 1 weights file (no endgame, no extras) judges as before`, () => {
    const w = randomWeights(v);
    const old = { variant: v.id, cells: e.cells, values: w.values };
    assert.ok(usable(old, e) && usable(w, e) && !usable({ ...w, values: w.values.slice(1) }, e) && !usable({ ...w, extras: { middle: [1], end: [1] } }, e) === (e.extraNames.length !== 1));
    const pos = e.from(v.replay(v.start(), someGame(v, 15)).states.at(-1));
    let sum = 0;   // the version 1 sum: a piece's value and its value on its cell, White's less Black's
    for (const [t, i, c] of e.pieces(pos)) {
      const k = TYPES.indexOf(t), x = w.values[k] + w.values[TYPES.length + k * e.cells + (c === 'w' ? i : e.mirror(i))];
      sum += c === 'w' ? x : -x;
    }
    assert.ok(Math.abs(evaluate(e, pos, old) - sum) < 1e-9);
  });

  test(`${v.id}: from the start it gives a legal move, in its time`, () => {
    const t = Date.now();
    const r = chooseMove(v, { start: v.start() }, weights(v), { timeMs: 300 });
    assert.ok(v.legal(v.start()).includes(r.move), r.move);
    assert.ok(r.depth >= 1 && Date.now() - t < 2000, `depth ${r.depth}, ${Date.now() - t} ms`);
  });
}

test('hex: it finds mate in one (Qc6#)', () => {
  const r = chooseMove(hex, { start: hexPosition({ a6: 'k', a1: 'K', b4: 'Q' }) }, weights(hex), { maxDepth: 2, timeMs: 60000 });
  assert.equal(r.move, 'b4c6');
  assert.ok(r.score > 900, String(r.score));
});

test('hex: it takes a queen left alone', () => {
  const r = chooseMove(hex, { start: hexPosition({ a6: 'k', l1: 'K', f3: 'R', f8: 'q' }) }, weights(hex), { maxDepth: 2, timeMs: 60000 });
  assert.equal(r.move, 'f3f8');
});

test('hex: the extras, worked out by hand for one position', () => {
  // White: king g1 (q 1, r 4), pawns f2 (0, 4) and g2 (1, 3), knight f6 (the middle), rook e9.
  // Black: king f11 (0, -5), pawn b7.
  const e = hex.engine;
  const pos = e.from(hexPosition({ g1: 'K', f2: 'P', g2: 'P', f6: 'N', e9: 'R', f11: 'k', b7: 'p' }));
  const x = Object.fromEntries(e.extraNames.map((n, k) => [n, e.extras(pos)[k]]));
  assert.equal(x['mobility N'], 12);                 // all 12 of the middle knight's cells are empty
  assert.equal(x['passed pawns'], 2 - 1);            // f2 and g2: no black pawn ahead on e-h; b7: no white pawn on a-c
  assert.equal(x['pawns by the king'], 2);           // f2 and g2 both touch g1 through a side: (-1, 0) and (0, -1)
  assert.equal(x['pieces near the enemy king'], 1);  // White's rook e9 is two steps from Black's king f11
  assert.equal(e.phase(pos), 3 / 26);                // a knight (1) and a rook (2) left, of 26 at the start
});

test('hex: no move once the game is over', () => {
  const start = hexPosition({ a6: 'k', a1: 'K', b4: 'Q' });
  assert.equal(chooseMove(hex, { start, moves: ['b4c6'] }, weights(hex), { maxDepth: 2 }).move, null);
});

test('chess: it finds mate in one (Qxf7#)', () => {
  const r = chooseMove(chess, { start: chess.start(), moves: ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6'] }, weights(chess), { maxDepth: 2, timeMs: 60000 });
  assert.equal(r.move, 'h5f7');
});

test('the weights list has a piece value for each kind and a cell table for each', () => {
  assert.deepEqual(TYPES, ['P', 'N', 'B', 'R', 'Q', 'K']);
  assert.equal(size(91), 6 * 92);
});
