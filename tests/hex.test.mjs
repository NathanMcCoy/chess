// Gliński's hexagonal chess (site/js/variants/hex.js), no browser. The expected numbers are worked
// out from the rules and the board's shape, not taken from the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import hex from '../site/js/variants/hex.js';
import { variant } from '../site/js/variants/index.js';

const { files, cells } = hex.geometry;
const len = f => cells.filter(c => c.file === f).length;
// A position from { cell: piece } (uppercase White), for the tests
function position(pieces, turn = 'w', { ep = '-', half = 0 } = {}) {
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
  return `${layout} ${turn} ${ep} ${half} 1`;
}
const from = (state, cell) => hex.legal(state).filter(m => m.startsWith(cell) && !/\d/.test(m[cell.length]));

test('it’s a variant like any other', () => {
  assert.equal(variant('hex'), hex);
  for (const f of ['start', 'turn', 'key', 'legal', 'replay']) assert.equal(typeof hex[f], 'function');
});

test('the board: 91 cells in 11 files of 6 to 11, a-l without j, three colours', () => {
  assert.equal(cells.length, 91);
  assert.equal(files, 'abcdefghikl');
  assert.deepEqual([...files].map(len), [6, 7, 8, 9, 10, 11, 10, 9, 8, 7, 6]);
  const colour = n => cells.find(c => c.name === n).colour;
  assert.equal(new Set(['f1', 'f2', 'f3'].map(colour)).size, 3, 'the three bishops start on three colours');
  assert.deepEqual([0, 1, 2].map(k => cells.filter(c => c.colour === k).length).sort(), [30, 30, 31]);
  assert.ok(!cells.some(c => c.name.startsWith('j')));
  assert.deepEqual(hex.geometry.last.w.sort(), ['a6', 'b7', 'c8', 'd9', 'e10', 'f11', 'g10', 'h9', 'i8', 'k7', 'l6'].sort());
});

test('the starting position, and White’s 51 first moves', () => {
  const s = hex.start();
  const expect = { g1: 'K', e1: 'Q', c1: 'R', i1: 'R', d1: 'N', h1: 'N', f1: 'B', f2: 'B', f3: 'B',
    b1: 'P', c2: 'P', d3: 'P', e4: 'P', f5: 'P', g4: 'P', h3: 'P', i2: 'P', k1: 'P',
    g10: 'k', e10: 'q', c8: 'r', i8: 'r', d9: 'n', h9: 'n', f9: 'b', f10: 'b', f11: 'b',
    b7: 'p', c7: 'p', d7: 'p', e7: 'p', f7: 'p', g7: 'p', h7: 'p', i7: 'p', k7: 'p' };
  for (const [cell, piece] of Object.entries(expect)) assert.equal(hex.pieceAt(s, cell), piece, cell);
  assert.equal(cells.filter(c => hex.pieceAt(s, c.name)).length, 36, 'and nothing else');
  assert.equal(hex.turn(s), 'w');
  assert.equal(hex.legal(s).length, 51, 'the figure usually given for Gliński’s opening position');
});

test('how far each piece reaches from the centre (f6) of an empty board', () => {
  // Kings on b1 and k7: on none of f6's lines
  const lone = p => from(position({ f6: p, b1: 'K', k7: 'k' }), 'f6').length;
  assert.equal(lone('R'), 30, 'rook: 6 sides x 5');
  assert.equal(lone('B'), 12, 'bishop: 6 corners x 2 (each corner step goes two cells out)');
  assert.equal(lone('Q'), 42);
  assert.equal(lone('N'), 12);
  // a king can't stand next to the other, so use one away from the black king
  assert.equal(from(position({ f6: 'K', a1: 'k' }), 'f6').length, 12, 'king: 6 sides + 6 corners');
});

test('a bishop stays on its colour', () => {
  const colour = name => cells.find(c => c.name === name).colour;
  for (const start of ['f1', 'f2', 'f3']) {
    const moves = from(position({ [start]: 'B', b1: 'K', k7: 'k' }), start);
    assert.ok(moves.length > 0, start);
    for (const m of moves) assert.equal(colour(m.slice(start.length)), colour(start), m);
  }
});

test('pawns: one step, a double step from a starting cell, captures at 60 degrees', () => {
  // A pawn on c2 captures forward-left on b2 and forward-right on d3 (as e4 captures on d4 and f5)
  const s = position({ c2: 'P', l1: 'K', a6: 'k', b2: 'n', d3: 'n' });
  assert.equal(hex.inCheck(s), false);
  assert.deepEqual(from(s, 'c2').sort(), ['c2b2', 'c2c3', 'c2c4', 'c2d3'], 'c2 is a starting cell: double step, and both captures');
  assert.deepEqual(from(position({ d2: 'P', l1: 'K', a6: 'k' }), 'd2'), ['d2d3'], 'd2 isn’t: one step only');
  assert.deepEqual(from(position({ f6: 'P', b1: 'K', k7: 'k' }), 'f6'), ['f6f7']);
});

test('en passant', () => {
  // Black's d7 pawn double-steps past d6, beside White's pawn on e6, which takes it there
  const s = position({ e6: 'P', d7: 'p', b1: 'K', k7: 'k' }, 'b');
  const r = hex.replay(s, ['d7d5', 'e6d6']);
  assert.deepEqual(r.names, ['d5', 'exd6']);
  assert.equal(hex.pieceAt(r.states[2], 'd5'), null, 'the pawn that went past is taken');
  assert.equal(hex.pieceAt(r.states[2], 'd6'), 'P');
  assert.equal(hex.replay(s, ['d7d5', 'k7l6', 'e6d6'].slice(0, 1)).states[1].split(' ')[2], 'd6', 'the passed cell is recorded');
});

test('promotion: four choices on the last cell of the file', () => {
  const s = position({ f10: 'P', b1: 'K', k7: 'k' });
  assert.deepEqual(from(s, 'f10').sort(), ['f10f11b', 'f10f11n', 'f10f11q', 'f10f11r']);
  const r = hex.replay(s, ['f10f11n']);
  assert.equal(r.names[0], 'f11=N');
  assert.equal(hex.pieceAt(r.states[1], 'f11'), 'N');
  assert.equal(hex.replay(s, ['f10f11']).error, 'not a legal move', 'a promotion must say what to');
});

test('a pinned piece may only move along the pin', () => {
  const s = position({ f1: 'K', f3: 'R', f8: 'r', a6: 'k' });
  const moves = from(s, 'f3');
  assert.ok(moves.length && moves.every(m => m[2] === 'f'), moves.join(' '));
});

test('checkmate: Qc6# (Black king a6, White king a1, queen b4)', () => {
  const r = hex.replay(position({ a6: 'k', a1: 'K', b4: 'Q' }), ['b4c6']);
  assert.deepEqual(r.names, ['Qc6#']);
  assert.deepEqual(r.result, { winner: 'w', reason: 'checkmate' });
});

test('stalemate scores 3/4 to the side giving it: Kb4 (Black king a6, White queen d7)', () => {
  const r = hex.replay(position({ a6: 'k', a2: 'K', d7: 'Q' }), ['a2b4']);
  assert.deepEqual(r.names, ['Kb4']);
  assert.deepEqual(r.result, { winner: null, reason: 'stalemate', points: { w: 0.75, b: 0.25 } });
});

test('other ways to a draw: material, repetition, fifty moves', () => {
  assert.equal(hex.replay(position({ b1: 'K', k7: 'k', f6: 'N' }), ['f6f7']).error, 'the game was already over', 'king and knight against king can’t mate');
  const s = hex.start();
  const out = hex.legal(s).find(m => m.startsWith('d1')), back = out.slice(2) + 'd1';
  const bOut = hex.legal(hex.replay(s, [out]).states[1]).find(m => m.startsWith('d9')), bBack = bOut.slice(2) + 'd9';
  const shuffle = [out, bOut, back, bBack, out, bOut, back, bBack];
  assert.deepEqual(hex.replay(s, shuffle).result, { winner: null, reason: 'repetition' });
  const r = hex.replay(position({ b1: 'K', k7: 'k', f6: 'R' }, 'w', { half: 99 }), ['b1b2']);
  assert.deepEqual(r.result, { winner: null, reason: 'fifty' });
});

test('names say which piece when two could go there', () => {
  // Rooks on c1 and c6 can both reach c4: the file is the same, so the rank tells them apart
  const r = hex.replay(position({ c1: 'R', c6: 'R', l1: 'K', l6: 'k' }), ['c1c4']);
  assert.equal(r.names[0], 'R1c4');
});

test('positions go to text and back, and refuse nonsense', () => {
  const s = hex.start();
  assert.equal(hex.replay(s, []).states[0], s);
  assert.equal(hex.replay('nonsense', []).error, 'not a position');
  assert.equal(hex.replay(s, ['e2e4']).error, 'not a legal move', 'square-chess moves aren’t hex moves');
  assert.equal(hex.replay(s, ['z9z9']).error, 'not a move');
  assert.equal(hex.key(hex.replay(s, ['b1b2']).states[1]).split(' ').length, 3, 'the key leaves out the move counters');
});
