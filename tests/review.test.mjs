// The review's arithmetic (site/js/review.js), no browser: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winChance, whiteChance, rate, accuracy, moveAccuracy, evalText } from '../site/js/review.js';

const near = (a, b, d = 0.5) => assert.ok(Math.abs(a - b) <= d, `${a} is not within ${d} of ${b}`);

test('win chance follows the published curve', () => {
  near(winChance({ cp: 0 }), 50, 0.001);
  near(winChance({ cp: 100 }), 59.1);
  near(winChance({ cp: 300 }), 75.1);
  near(winChance({ cp: -300 }), 24.9);
  assert.equal(winChance({ mate: 2 }), 100);
  assert.equal(winChance({ mate: -1 }), 0);
  assert.equal(winChance({ mate: 0 }), 0, 'mated');
  assert.equal(winChance(null), 50, 'no score yet');
});

test('White’s chance flips for Black to move', () => {
  near(whiteChance({ cp: 300 }, 'b'), 24.9);
  near(whiteChance({ cp: 300 }, 'w'), 75.1);
});

test('the engine’s own move is best, however the score moves', () => {
  const before = { turn: 'w', score: { cp: 50 }, best: 'e2e4' };
  assert.equal(rate(before, { turn: 'b', score: { cp: -20 } }, 'e2e4').rating, 'best');
});

test('moves are rated by the win chance they give away, for either side', () => {
  const even = { turn: 'w', score: { cp: 0 }, best: 'e2e4' };
  // White to move at 0.0; afterwards it's Black to move, so the score is Black's
  assert.equal(rate(even, { turn: 'b', score: { cp: 5 } }, 'd2d4').rating, 'excellent');    // ~0.5 lost
  assert.equal(rate(even, { turn: 'b', score: { cp: 60 } }, 'd2d4').rating, 'good');        // ~5.5 lost
  assert.equal(rate(even, { turn: 'b', score: { cp: 150 } }, 'd2d4').rating, 'inaccuracy'); // ~13.5 lost
  assert.equal(rate(even, { turn: 'b', score: { cp: 250 } }, 'd2d4').rating, 'mistake');    // ~21.5 lost
  assert.equal(rate(even, { turn: 'b', score: { mate: 1 } }, 'g2g4').rating, 'blunder');    // allows mate
  // The same from Black's side
  const black = { turn: 'b', score: { cp: 0 }, best: 'e7e5' };
  assert.equal(rate(black, { turn: 'w', score: { mate: 1 } }, 'g7g5').rating, 'blunder');
  assert.equal(rate(black, { turn: 'w', score: { cp: -30 } }, 'd7d5').rating, 'excellent', 'gaining is never a loss');
});

test('the only legal move counts as best', () => {
  const r = rate({ turn: 'w', score: { cp: -500 }, best: 'e1f1' }, { turn: 'b', score: { cp: 900 } }, 'e1d1', 1);
  assert.equal(r.rating, 'best');
  assert.equal(r.forced, true);
});

test('Fool’s Mate: g4 allows mate in one, Qh4# is the mate', () => {
  // after 1. f3 e5, White to move; the engine sees nothing special yet
  const g4 = rate({ turn: 'w', score: { cp: -80 }, best: 'b1c3' }, { turn: 'b', score: { mate: 1 } }, 'g2g4');
  assert.equal(g4.rating, 'blunder');
  const qh4 = rate({ turn: 'b', score: { mate: 1 }, best: 'd8h4' }, { turn: 'w', score: { mate: 0 } }, 'd8h4');
  assert.equal(qh4.rating, 'best');
});

test('accuracy: perfect play is 100, and bad moves weigh heavily', () => {
  near(moveAccuracy(0), 100, 0.01);
  near(moveAccuracy(10), 63.6);   // 103.1668 × e^(−0.4354) − 3.1669
  assert.equal(accuracy([]), null);
  near(accuracy([0, 0, 0]), 100, 0.01);
  const mixed = accuracy([0, 0, 0, 40]);
  assert.ok(mixed < 80 && mixed > 40, `one blunder in four moves gives ${mixed}`);
});

test('evaluations are written from White’s side', () => {
  assert.equal(evalText({ cp: 130 }, 'w'), '+1.3');
  assert.equal(evalText({ cp: 130 }, 'b'), '−1.3');
  assert.equal(evalText({ cp: 0 }, 'b'), '0.0');
  assert.equal(evalText({ mate: 3 }, 'w'), 'M3');
  assert.equal(evalText({ mate: 2 }, 'b'), '−M2');
  assert.equal(evalText({ mate: 0 }, 'w'), '0-1', 'White is mated');
});
