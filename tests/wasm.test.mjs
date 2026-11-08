// The browser's hex bot as WebAssembly (site/js/bot/hex-engine.wasm, from trainer/src), no browser.
// It must be built from the Rust source as it is now (or it could differ from what the cross-check
// in trainer.test.mjs proves), play mates and free captures, give only legal moves, and keep to its time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import hex from '../site/js/variants/hex.js';
import { loadEngine } from '../site/js/bot/wasm.js';

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
  for (const f of ['lib.rs', 'hex.rs', 'search.rs', 'wasm.rs']) {
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
