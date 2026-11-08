// The site's bot, in a Web Worker, so the page doesn't stop while it thinks (as Stockfish runs on the
// chess page). The page sends { id, variant, start, moves, timeMs } and gets back
// { id, move, score, depth, engine } or { id, error }. It uses the trained weights in
// /data/bot/<variant>.json, or the untrained ones if they can't be loaded.
//
// For hex it thinks with the Rust engine compiled to WebAssembly (wasm.js: the same rules and
// judgement, about 40 times faster, so it sees much further in the same time), and falls back to
// bot.js if that can't load or ever fails. `engine` in the answer says which did it: 'wasm' or 'js'.
// The WebAssembly engine judges by the neural network in /data/bot/hex-net.bin when that loads
// (tools/build-net.mjs makes it), else by the weights; `judge` says which: 'net' or 'weights'.
import { variant } from '../variants/index.js';
import { chooseMove, startingWeights, usable } from './bot.js';
import { loadEngine } from './wasm.js';

const loaded = {};
function weightsFor(v) {
  loaded[v.id] ??= fetch(`/data/bot/${v.id}.json`)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null)
    .then(w => (usable(w, v.engine) ? w : startingWeights(v.id, v.engine.cells, v.engine.extraNames)));
  return loaded[v.id];
}

// The WebAssembly engine with these weights, or null (then bot.js plays)
const fast = {};
function fastFor(v, w) {
  if (v.id !== 'hex') return Promise.resolve(null);
  fast[v.id] ??= fetch('/js/bot/hex-engine.wasm')
    .then(r => { if (!r.ok) throw new Error(`the engine answered ${r.status}`); return r.arrayBuffer(); })
    .then(bytes => loadEngine(bytes))
    .then(async engine => {
      engine.setWeights(w, v.engine.extraNames.length);
      engine.judge = 'weights';
      const net = await fetch('/data/bot/hex-net.bin')
        .then(r => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null);
      if (net) {
        try { engine.setNet(new Uint8Array(net)); engine.judge = 'net'; } catch { /* the weights, then */ }
      }
      return engine;
    })
    .catch(() => null);
  return fast[v.id];
}

onmessage = async ({ data }) => {
  try {
    const v = variant(data.variant);
    if (!v) throw new Error('unknown variant');
    const w = await weightsFor(v);
    const engine = await fastFor(v, w);
    if (engine) {
      try {
        const r = engine.choose(data.start, data.moves, data.timeMs);
        return postMessage({ id: data.id, move: r.move, score: r.score, depth: r.depth, engine: 'wasm', judge: engine.judge });
      } catch { /* bot.js below */ }
    }
    const r = chooseMove(v, { start: data.start, moves: data.moves }, w, { timeMs: data.timeMs });
    postMessage({ id: data.id, move: r.move, score: r.score, depth: r.depth, engine: 'js' });
  } catch (e) {
    postMessage({ id: data.id, error: e.message });
  }
};
