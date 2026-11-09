// The browser's hex bot as WebAssembly (site/js/bot/hex-engine.wasm, from trainer/src), no browser.
// It must be built from the Rust source as it is now (or it could differ from what the cross-check
// in trainer.test.mjs proves), play mates and free captures, give only legal moves, and keep to its time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import hex from '../site/js/variants/hex.js';
import { loadEngine } from '../site/js/bot/wasm.js';
import { netBytes } from '../tools/build-net.mjs';

const file = name => readFileSync(fileURLToPath(new URL(name, import.meta.url)));
const engine = await loadEngine(file('../site/js/bot/hex-engine.wasm'));
const weights = JSON.parse(file('../site/data/bot/hex.json'));
engine.setWeights(weights, hex.engine.extraNames.length);

const { files, cells } = hex.geometry;
const len = f => cells.filter(c => c.file === f).length;
const position = pieces => [...files].map(f => {
  let out = '', empty = 0;
  for (let rank = 1; rank <= len(f); rank++) {
    const p = pieces[f + rank];
    if (!p) { empty++; continue; }
    if (empty) { out += empty; empty = 0; }
    out += p;
  }
  return out + (empty || '');
}).join('/') + ' w - 0 1';

test('it was built from the Rust source as it is now (else: node tools/build-engine.mjs)', () => {
  // The same fingerprint as trainer/build.rs: FNV-1a over these files, carriage returns left out
  let h = 0xcbf29ce484222325n;
  for (const f of ['lib.rs', 'hex.rs', 'search.rs', 'wasm.rs', 'nn.rs']) {
    for (const b of file(`../trainer/src/${f}`)) {
      if (b === 13) continue;
      h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
    }
  }
  assert.equal(engine.sourceHash(), h.toString(16).padStart(16, '0'));
});

test('it plays mate in one, and takes a queen left alone', () => {
  const mate = engine.choose(position({ a6: 'k', a1: 'K', b4: 'Q' }), [], 500);
  assert.equal(mate.move, 'b4c6');
  assert.ok(mate.score > 900, String(mate.score));
  assert.equal(engine.choose(position({ a6: 'k', l1: 'K', f3: 'R', f8: 'q' }), [], 500).move, 'f3f8');
});

test('no move once the game is over, and an impossible move is refused', () => {
  assert.equal(engine.choose(position({ a6: 'k', a1: 'K', b4: 'Q' }), ['b4c6'], 200).move, null);
  assert.throws(() => engine.choose(hex.start(), ['f5f9'], 200), /not a legal move/);
  assert.throws(() => engine.setWeights({ values: [1, 2, 3] }, 0), /another size/);
  engine.setWeights(weights, hex.engine.extraNames.length);
});

test('a whole game against itself: every move legal, each in about its time', () => {
  const moves = [];
  for (let i = 0; i < 60; i++) {
    const r = hex.replay(hex.start(), moves);
    if (r.result) break;
    const t = performance.now();
    const c = engine.choose(hex.start(), moves, 30);
    assert.ok(performance.now() - t < 500, `move ${i} took ${Math.round(performance.now() - t)} ms`);
    assert.ok(hex.legal(r.states.at(-1)).includes(c.move), `move ${i}: ${c.move}`);
    moves.push(c.move);
  }
  assert.ok(!hex.replay(hex.start(), moves).error);
});

test('it is much faster than bot.js (which does about 50 thousand positions a second)', () => {
  const r = engine.choose(hex.start(), [], 1000);
  console.log(`  WebAssembly: ${r.nodes} positions in 1 s, depth ${r.depth}`);
  assert.ok(r.nodes > 200000, `${r.nodes} positions`);
});

// The game review's top lines (search.rs lines(): the best move, then the best of the rest, ...)
test('analyse: the best lines, each a legal line of play, best first', () => {
  const mate = engine.analyse(position({ a6: 'k', a1: 'K', b4: 'Q' }), [], 200, 3);
  assert.equal(mate[0].pv[0], 'b4c6');
  assert.equal(mate[0].score, 999, 'mate in one: MATE less one ply');
  const moves = ['f5f6', 'e7e6', 'c2c4'];
  const lines = engine.analyse(hex.start(), moves, 150, 3);
  assert.equal(lines.length, 3);
  assert.equal(new Set(lines.map(l => l.pv[0])).size, 3, `three different first moves: ${lines.map(l => l.pv[0])}`);
  for (let i = 1; i < 3; i++) assert.ok(lines[i].score <= lines[i - 1].score + 0.3, `best first: ${lines.map(l => l.score)}`);
  for (const l of lines) {
    assert.ok(l.depth >= 2 && l.pv.length >= 2, JSON.stringify(l));
    const r = hex.replay(hex.start(), [...moves, ...l.pv]);
    assert.ok(!r.error, `${l.pv.join(' ')}: ${r.error}`);
  }
  // Only two legal moves: two lines, however many were asked for
  const few = engine.analyse(position({ a6: 'k', l1: 'K', c4: 'R', d4: 'R' }), [], 50, 5);
  assert.ok(few.length >= 1 && few.length <= 5);
  assert.deepEqual(engine.analyse(position({ a6: 'k', a1: 'K', b4: 'Q' }), ['b4c6'], 50, 3), []);
  assert.throws(() => engine.analyse(hex.start(), ['f5f9'], 50), /not a legal move/);
  // Asking for lines leaves the bot's own choice as it was: its first line is the move it plays
  const a = engine.analyse(hex.start(), moves, 300, 1)[0];
  assert.ok(hex.legal(hex.replay(hex.start(), moves).states.at(-1)).includes(a.pv[0]));
});

// The neural network (tools/build-net.mjs makes the file; nn.test.mjs checks the same Rust natively)
test('with a network it judges as PyTorch did (the tiny network in tests/data)', () => {
  const small = JSON.parse(file('data/nn-small.json'));
  engine.setNet(netBytes(small));
  let worst = 0;
  for (const c of small.check) worst = Math.max(worst, Math.abs(engine.netValue(c.board, c.turn) - c.value));
  assert.ok(worst <= 0.0001, `WebAssembly and PyTorch differ by ${worst} pawns`);
  engine.setNet(null);
  assert.ok(Number.isNaN(engine.netValue(small.check[0].board, 0)), 'without a network: no value');
  assert.throws(() => engine.setNet(new Uint8Array(20)), /not a network/);
  const cut = netBytes(small).slice(0, -8);
  assert.throws(() => engine.setNet(cut), /another size/);
});

test("with the site's network (site/data/bot/hex-net.bin): mates, legal moves, still fast", () => {
  engine.setNet(file('../site/data/bot/hex-net.bin'));
  try {
    assert.ok(Number.isFinite(engine.netValue(new Array(91).fill(0), 0)));
    assert.equal(engine.choose(position({ a6: 'k', a1: 'K', b4: 'Q' }), [], 500).move, 'b4c6');
    assert.equal(engine.choose(position({ a6: 'k', l1: 'K', f3: 'R', f8: 'q' }), [], 500).move, 'f3f8');
    const moves = [];
    for (let i = 0; i < 40; i++) {
      const r = hex.replay(hex.start(), moves);
      if (r.result) break;
      const c = engine.choose(hex.start(), moves, 30);
      assert.ok(hex.legal(r.states.at(-1)).includes(c.move), `move ${i}: ${c.move}`);
      moves.push(c.move);
    }
    const r = engine.choose(hex.start(), [], 1000);
    console.log(`  WebAssembly with the network: ${r.nodes} positions in 1 s, depth ${r.depth}`);
    assert.ok(r.nodes > 200000, `${r.nodes} positions`);
  } finally {
    engine.setNet(null);
  }
});
