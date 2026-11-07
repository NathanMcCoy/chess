// The rules interface (site/js/variants), no browser: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { variant, VARIANTS, DEFAULT_VARIANT } from '../site/js/variants/index.js';

const chess = variant('chess');

test('variants are looked up by id, and a missing id means chess', () => {
  assert.equal(variant('chess'), VARIANTS.chess);
  assert.equal(variant(undefined), VARIANTS.chess, 'saves from before variants existed');
  assert.equal(DEFAULT_VARIANT, 'chess');
  assert.equal(variant('hex'), null, 'not yet');
});

test('every variant provides the whole interface', () => {
  for (const v of Object.values(VARIANTS)) {
    for (const f of ['start', 'turn', 'key', 'legal', 'replay']) assert.equal(typeof v[f], 'function', `${v.id}.${f}`);
    assert.equal(typeof v.id, 'string');
    const s = v.start();
    assert.equal(v.turn(s), 'w');
    assert.ok(v.legal(s).length > 0);
    assert.deepEqual(v.replay(s, []).states, [s]);
  }
});

test('chess: the start, whose turn, and legal moves in UCI', () => {
  const s = chess.start();
  assert.equal(chess.legal(s).length, 20);
  assert.ok(chess.legal(s).includes('e2e4') && chess.legal(s).includes('g1f3'));
});

test('replay plays a game and names its moves', () => {
  const r = chess.replay(chess.start(), ['e2e4', 'e7e5', 'g1f3']);
  assert.deepEqual(r.names, ['e4', 'e5', 'Nf3']);
  assert.equal(r.states.length, 4);
  assert.equal(chess.turn(r.states[3]), 'b');
  assert.equal(r.result, null);
});

test('replay finds the end of a game', () => {
  assert.deepEqual(chess.replay(chess.start(), ['f2f3', 'e7e5', 'g2g4', 'd8h4']).result, { winner: 'b', reason: 'checkmate' });
  const knights = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
  assert.deepEqual(chess.replay(chess.start(), knights).result, { winner: null, reason: 'repetition' });
});

test('replay refuses what isn’t a legal move, and says where', () => {
  assert.deepEqual(chess.replay(chess.start(), ['e2e4', 'e2e4']), { error: 'not a legal move', at: 1 });
  assert.deepEqual(chess.replay(chess.start(), ['e2e4', 'Nf6']), { error: 'not a move', at: 1 }, 'SAN is not accepted');
  assert.deepEqual(chess.replay(chess.start(), [42]), { error: 'not a move', at: 0 });
  assert.deepEqual(chess.replay(chess.start(), ['f2f3', 'e7e5', 'g2g4', 'd8h4', 'a2a3']), { error: 'the game was already over', at: 4 });
  assert.deepEqual(chess.replay('not a fen', []), { error: 'not a position', at: -1 });
});

test('promotion is part of the move', () => {
  const r = chess.replay('7k/P7/8/8/8/8/8/K7 w - - 0 1', ['a7a8n']);
  assert.deepEqual(r.names, ['a8=N']);
  assert.equal(chess.replay('7k/P7/8/8/8/8/8/K7 w - - 0 1', ['a7a8k']).error, 'not a move');
});

test('a position’s key ignores the move counters, so transpositions match', () => {
  // 1. Nc3, and 1. Nf3 Nf6 2. Ng1 Ng8 3. Nc3: the same position, reached six moves later
  const a = chess.replay(chess.start(), ['b1c3']).states[1];
  const b = chess.replay(chess.start(), ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'b1c3']).states[5];
  assert.notEqual(a, b, 'the FENs differ in their move counters');
  assert.equal(chess.key(a), chess.key(b));
});
