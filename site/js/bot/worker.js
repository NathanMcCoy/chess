// The site's bot, in a Web Worker, so the page doesn't stop while it thinks (as Stockfish runs on the
// chess page). The page sends { id, variant, start, moves, timeMs } and gets back
// { id, move, score, depth } or { id, error }. It uses the trained weights in /data/bot/<variant>.json,
// or the untrained ones if they can't be loaded.
import { variant } from '../variants/index.js';
import { chooseMove, startingWeights, prepare } from './bot.js';

const loaded = {};
function weightsFor(v) {
  loaded[v.id] ??= fetch(`/data/bot/${v.id}.json`)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null)
    .then(w => prepare(w, v.engine) || startingWeights(v.id, v.engine.cells, v.engine.extraNames));
  return loaded[v.id];
}

onmessage = async ({ data }) => {
  try {
    const v = variant(data.variant);
    if (!v) throw new Error('unknown variant');
    const w = await weightsFor(v);
    const r = chooseMove(v, { start: data.start, moves: data.moves }, w, { timeMs: data.timeMs });
    postMessage({ id: data.id, move: r.move, score: r.score, depth: r.depth });
  } catch (e) {
    postMessage({ id: data.id, error: e.message });
  }
};
