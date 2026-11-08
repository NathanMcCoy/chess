// Teaches the site's bot (site/js/bot/bot.js) by playing itself. Each generation:
//   1. self-play: the bot plays itself, each game from a few random moves so the games differ. Every
//      quiet position keeps what the bot's search found when it got there.
//   2. learning: the weights are changed (gradient descent) until the bot's quick judgement of each
//      position matches what its search found: it learns to see at a glance what it used to need
//      to look ahead for ("bootstrapping"). This and the last two rounds' positions are used.
//      Learning from how the games ended instead ("Texel tuning") made it worse every time: these
//      games are weak, mostly decided by blunders long after the position (Nov 7).
//   3. proof: the new weights play the old ones, each opening twice with colours swapped. They're
//      kept only if they win by twice the match's margin of error, and then also play the
//      untrained weights, to show how far it's come. Every match goes in the weights file.
// The weights go to site/data/bot/<variant>.json, which the page's bot loads.
//
//   node tools/train-bot.mjs --variant hex --generations 5
// Options: --games (self-play games a generation, 400), --match (match games, 400), --baseline
// (games against the untrained weights when kept, 200), --keep (rounds of positions learned from,
// 3), --nodes (positions the bot looks at per move, 2000), --threads (default: this PC's, less
// two), --out (a different weights file, for trying things), --reuse <file> (keep the self-play
// games there, and learn from them again on the next run instead of playing new ones), --learn
// (which numbers may change: values,shape,cells, the default being all three; for finding what
// helps), --lambda (how much each position's target is its game's result rather than the search's
// score: 0), --compare A B (only a match between two weights files, "start" being the untrained
// ones; --nodes-b gives B its own positions a move).
// Moves are limited by positions looked at, not time, so a busy machine doesn't change the games.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { variant } from '../site/js/variants/index.js';
import { chooseMove, features, startingWeights } from '../site/js/bot/bot.js';

const MAX_PLIES = 240;   // a game this long is called a draw
const T = 6;             // kinds of piece: P N B R Q K

// --- One game -------------------------------------------------------------------------------------
// opening: the random first moves; white, black: their weights; nodes: positions a move, the same
// for both or { w, b }. Gives the result as White's points, and (when `record`) the quiet
// positions met, as feature lists.
function playGame(v, opening, white, black, nodes, record) {
  const budget = typeof nodes === 'number' ? { w: nodes, b: nodes } : nodes;
  const e = v.engine;
  let pos = e.from(v.start());
  for (const text of opening) pos = e.play(pos, e.moves(pos).find(m => e.text(m) === text));
  const counts = new Map();   // how often each position has come up (three times is a draw)
  const bump = () => { const k = e.key(pos); counts.set(k, (counts.get(k) || 0) + 1); return counts.get(k); };
  bump();
  const kept = [];
  const done = result => ({ result, positions: kept });
  for (let ply = opening.length; ; ply++) {
    const list = e.moves(pos);
    if (!list.length) {
      const r = e.noMoves(pos);
      return done(r.winner ? (r.winner === 'w' ? 1 : 0) : r.points ? r.points.w : 0.5);
    }
    if (e.drawn(pos) || ply >= MAX_PLIES) return done(0.5);
    const side = e.turn(pos);
    const r = chooseMove(v, { pos, seen: new Set(counts.keys()) }, side === 'w' ? white : black, { maxNodes: budget[side], timeMs: 1e9 });
    const m = list.find(o => e.text(o) === r.move);
    // Quiet positions only: not in check, and the move chosen isn't a capture or promotion, so the
    // position's value isn't about to swing. Each keeps what the search thought of it, for White
    // (mates counted as 20 pawns), as well as how the game ends.
    if (record && !e.inCheck(pos) && !e.captured(pos, m) && !e.promotion(m)) {
      const score = Math.max(-20, Math.min(20, side === 'w' ? r.score : -r.score));
      kept.push([features(e, pos, e.cells), score]);
    }
    pos = e.play(pos, m);
    if (bump() >= 3) return done(0.5);   // the same position three times
  }
}

if (!isMainThread) {
  const v = variant(workerData.variant);
  parentPort.on('message', job => {
    const out = playGame(v, job.opening, job.white, job.black, job.nodes, job.record);
    parentPort.postMessage({ id: job.id, ...out });
  });
} else {
  await main();
}

// --- The generations ------------------------------------------------------------------------------
async function main() {
  const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
  const v = variant(arg('variant', 'hex'));
  if (!v) throw new Error('unknown variant');
  const generations = Number(arg('generations', 3));
  const gamesPer = Number(arg('games', 400));
  const matchGames = Number(arg('match', 400));
  const baselineGames = Number(arg('baseline', 200));
  const keepRounds = Number(arg('keep', 3));
  const nodes = Number(arg('nodes', 2000));
  const threads = Number(arg('threads', Math.max(1, availableParallelism() - 2)));
  const file = arg('out') ? pathToFileURL(resolve(arg('out'))) : new URL(`../site/data/bot/${v.id}.json`, import.meta.url);
  mkdirSync(new URL('.', file), { recursive: true });
  let weights = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { ...startingWeights(v.id, v.engine.cells), history: [] };
  console.log(`${v.id}: generation ${weights.generation}, ${threads} threads, ${nodes} positions a move`);

  const pool = Array.from({ length: threads }, () => new Worker(new URL(import.meta.url), { workerData: { variant: v.id } }));
  let nextId = 0;
  const pending = new Map();
  for (const w of pool) w.on('message', msg => { pending.get(msg.id)(msg); pending.delete(msg.id); });
  const queue = [];
  const idle = [...pool];
  const run = job => new Promise(resolve => { queue.push({ job: { ...job, id: nextId++ }, resolve }); pump(); });
  function pump() {
    while (idle.length && queue.length) {
      const worker = idle.pop();
      const { job, resolve } = queue.shift();
      pending.set(job.id, msg => { idle.push(worker); resolve(msg); pump(); });
      worker.postMessage(job);
    }
  }

  // Random first moves, from a seeded sequence so a run can be repeated
  let seed = 12345 + weights.generation * 1000;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const opening = () => {
    const moves = [];
    const n = 2 + Math.floor(rand() * 7);
    let pos = v.engine.from(v.start());
    for (let i = 0; i < n; i++) {
      const list = v.engine.moves(pos);
      if (!list.length) break;
      const m = list[Math.floor(rand() * list.length)];
      moves.push(v.engine.text(m));
      pos = v.engine.play(pos, m);
    }
    return moves;
  };

  // A match: each opening twice, `a` once as each colour. Gives a's score, 0 to 1, and its margin
  // of error (the score's standard error, from the games' spread).
  async function match(a, b, games, nodesA = nodes, nodesB = nodes) {
    const pairs = Array.from({ length: Math.ceil(games / 2) }, opening);
    const results = await Promise.all(pairs.flatMap(o => [
      run({ opening: o, white: a, black: b, nodes: { w: nodesA, b: nodesB }, record: false }).then(r => r.result),
      run({ opening: o, white: b, black: a, nodes: { w: nodesB, b: nodesA }, record: false }).then(r => 1 - r.result),
    ]));
    const score = results.reduce((x, y) => x + y, 0) / results.length;
    const wins = results.filter(r => r > 0.5).length, losses = results.filter(r => r < 0.5).length;
    const sd = Math.sqrt(results.reduce((x, r) => x + (r - score) ** 2, 0) / results.length / results.length);
    return { score, sd, wins, losses, draws: results.length - wins - losses, games: results.length };
  }
  const said = m => `${(m.score * 100).toFixed(1)}% ± ${(m.sd * 100).toFixed(1)} (${m.wins} wins, ${m.losses} losses, ${m.draws} draws)`;

  // --compare A B: only a match between two weights files ("start" for the untrained weights), each
  // with its own positions a move (--nodes, --nodes-b): to check which is stronger
  if (arg('compare')) {
    const i = process.argv.indexOf('--compare');
    const load = name => (name === 'start' ? startingWeights(v.id, v.engine.cells) : JSON.parse(readFileSync(name, 'utf8')));
    const [a, b] = [load(process.argv[i + 1]), load(process.argv[i + 2])];
    const t = Date.now();
    const m = await match(a, b, matchGames, nodes, Number(arg('nodes-b', nodes)));
    console.log(`  ${process.argv[i + 1]} against ${process.argv[i + 2]}: ${said(m)}, ${((Date.now() - t) / 1000).toFixed(0)} s`);
    await Promise.all(pool.map(w => w.terminate()));
    return;
  }

  const earlier = [];   // the positions from the last few rounds' self-play, learned from again
  for (let g = 0; g < generations; g++) {
    const t0 = Date.now();
    // 1. Self-play (or, with --reuse <file>, the games saved there by an earlier run: for trying
    // changes to the learning on the same games)
    const reuse = arg('reuse');
    let games;
    if (reuse && existsSync(reuse)) {
      games = JSON.parse(readFileSync(reuse, 'utf8')).map(([result, positions]) => ({ result, positions: positions.map(([f, s]) => [Int32Array.from(f), s]) }));
      console.log(`  (self-play games read from ${reuse})`);
    } else {
      games = await Promise.all(Array.from({ length: gamesPer }, () => run({ opening: opening(), white: weights, black: weights, nodes, record: true })));
      if (reuse) writeFileSync(reuse, JSON.stringify(games.map(r => [r.result, r.positions.map(([f, s]) => [[...f], s])])));
    }
    // This round's positions and the last few rounds' (--keep): learning from one round's 400 games
    // alone gave weights that varied a lot from round to round (38% to 55% against the last, Nov 7)
    earlier.push(games.flatMap(r => r.positions.map(([f, score]) => [f, r.result, score])));
    if (earlier.length > keepRounds) earlier.shift();
    const data = earlier.flat();
    for (let i = data.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [data[i], data[j]] = [data[j], data[i]]; }   // mixed, not game by game
    const decided = games.filter(r => r.result !== 0.5).length;
    console.log(`  self-play: ${games.length} games (${decided} decided); learning from ${data.length} positions of the last ${earlier.length} round(s), ${((Date.now() - t0) / 1000).toFixed(0)} s`);

    // 2. Learning
    const t1 = Date.now();
    const learned = tune(weights, data, v.engine, new Set(arg('learn', 'values,shape,cells').split(',')), Number(arg('lambda', 0)));
    const next = { ...weights, values: learned.values, shape: learned.shape };
    const show = a => a.slice(0, 5).map(x => x.toFixed(2)).join(' ');
    console.log(`  learning: ${((Date.now() - t1) / 1000).toFixed(1)} s, prediction error ${learned.fit.before} -> ${learned.fit.after}`);
    console.log(`    values (P N B R Q) ${show(learned.values)}; further up ${show(learned.shape.advance)}; middle ${show(learned.shape.centre)}`);

    // 3. The match: each opening twice, the new weights once as each colour
    const t2 = Date.now();
    const m = await match(next, weights, matchGames);
    // Better by twice the match's margin of error: once let a lucky 54.8% through (Nov 7)
    const kept = m.score - 2 * m.sd > 0.5;
    console.log(`  match: new ${said(m)}, ${((Date.now() - t2) / 1000).toFixed(0)} s: ${kept ? 'kept' : 'not kept'}`);
    const entry = { generation: weights.generation + 1, selfPlay: games.length, positions: data.length, match: { games: m.games, score: Number(m.score.toFixed(3)), wins: m.wins, losses: m.losses }, kept, at: new Date().toISOString() };
    // How far it's come: kept weights also play the untrained ones, on fresh openings
    if (kept && baselineGames) {
      const b = await match(next, startingWeights(v.id, v.engine.cells), baselineGames);
      console.log(`  against the untrained bot: ${said(b)}`);
      entry.untrained = { games: b.games, score: Number(b.score.toFixed(3)) };
    }
    weights = kept ? { ...next, generation: weights.generation + 1, history: [...(weights.history || []), entry] }
      : { ...weights, history: [...(weights.history || []), entry] };
    writeFileSync(file, JSON.stringify({ ...weights, values: weights.values.map(x => Number(x.toFixed(4))) }) + '\n');
  }
  await Promise.all(pool.map(w => w.terminate()));
}

// --- Learning: make sigmoid(evaluation) predict each position's result ------------------------------
// What's learned, for each kind of piece:
//   its value;
//   how much better it is further up the board, and nearer the middle (`shape`: two numbers each,
//   shared by every cell, so a few hundred games are enough to learn them);
//   an extra for each single cell, held near nothing unless many games call for it. (Learning every
//   cell freely from 400 games made the bot much worse: 35.5% against the untrained one, Nov 7.)
// The bot itself only sees the sum: a value per piece kind and one per piece kind on each cell.
// The sigmoid's scale is fitted to the games first, so lots of draws can't just shrink every number.
// Adam (gradient descent that adapts its own step size) over every position, many times.
// learn: which groups may change: 'values', 'shape' (advance and middle), 'cells' (the per-cell extras)
// lambda: how much of each position's target is its game's result (the rest is the search's score)
function tune(weights, data, e, learn, lambda) {
  const cells = e.cells, info = Array.from({ length: cells }, (_, i) => e.cellInfo(i));
  const shape = weights.shape || { advance: new Array(T).fill(0), centre: new Array(T).fill(0) };
  // theta: [values 0-5, advance 6-11, centre 12-17, per-cell extras from EXTRA]
  const EXTRA = 3 * T;
  const theta = new Float64Array(EXTRA + T * cells);
  for (let t = 0; t < T; t++) {
    theta[t] = weights.values[t]; theta[T + t] = shape.advance[t]; theta[2 * T + t] = shape.centre[t];
    for (let i = 0; i < cells; i++) {
      theta[EXTRA + t * cells + i] = weights.values[T + t * cells + i] - shape.advance[t] * info[i][0] - shape.centre[t] * info[i][1];
    }
  }
  const old = Float64Array.from(theta);
  const w = new Float64Array(weights.values.length);
  const bake = () => {
    for (let t = 0; t < T; t++) {
      w[t] = theta[t];
      for (let i = 0; i < cells; i++) w[T + t * cells + i] = theta[T + t] * info[i][0] + theta[2 * T + t] * info[i][1] + theta[EXTRA + t * cells + i];
    }
  };
  bake();
  const evalOf = f => { let x = 0; for (const k of f) x += k > 0 ? w[k - 1] : -w[-k - 1]; return x; };
  const sig = x => 1 / (1 + Math.exp(-x));
  const error = (K, target = (r) => r) => data.reduce((s, row) => s + (target(row[1], row[2]) - sig(K * evalOf(row[0]))) ** 2, 0) / data.length;
  // The scale: the K that makes the current weights predict best (golden-section search)
  let lo = 0.02, hi = 3;
  for (let i = 0; i < 40; i++) {
    const a = hi - (hi - lo) / 1.618, b = lo + (hi - lo) / 1.618;
    if (error(a) < error(b)) hi = b; else lo = a;
  }
  const K = (lo + hi) / 2;
  // What each position should be judged: lambda parts how its game ended, the rest what the search
  // found when it got there (a deeper look than the bot's quick judgement: learning to match it is
  // "bootstrapping", how engines learn from their own weak games, where most results are draws)
  const target = (result, score) => lambda * result + (1 - lambda) * sig(K * score);
  const targets = Float64Array.from(data, row => target(row[1], row[2]));
  const before = error(K, target);

  const PULL = 1e-4, HOLD = 1e-2, RATE = 0.01, EPOCHS = 60, BATCH = 4096;
  const m = new Float64Array(theta.length), s = new Float64Array(theta.length);
  let step = 0;
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    for (let at = 0; at < data.length; at += BATCH) {
      const g = new Float64Array(w.length);
      const end = Math.min(at + BATCH, data.length), n = end - at;
      for (let j = at; j < end; j++) {   // each weight counted, as index + 1, negative for Black
        const f = data[j][0];
        const p = sig(K * evalOf(f));
        const d = 2 * (p - targets[j]) * p * (1 - p) * K / n;
        for (const k of f) { if (k > 0) g[k - 1] += d; else g[-k - 1] -= d; }
      }
      // From the bot's numbers' slopes to what's learned
      const gt = new Float64Array(theta.length);
      for (let t = 0; t < T; t++) {
        gt[t] = g[t];
        for (let i = 0; i < cells; i++) {
          const gc = g[T + t * cells + i];
          gt[T + t] += gc * info[i][0]; gt[2 * T + t] += gc * info[i][1]; gt[EXTRA + t * cells + i] = gc;
        }
      }
      step++;
      const group = k => (k < T ? 'values' : k < EXTRA ? 'shape' : 'cells');
      for (let k = 0; k < theta.length; k++) {
        if (!learn.has(group(k))) continue;
        const pull = k < EXTRA ? 2 * PULL * (theta[k] - old[k]) : 2 * HOLD * theta[k];
        const gk = gt[k] + pull;
        m[k] = 0.9 * m[k] + 0.1 * gk;
        s[k] = 0.999 * s[k] + 0.001 * gk * gk;
        theta[k] -= RATE * (m[k] / (1 - 0.9 ** step)) / (Math.sqrt(s[k] / (1 - 0.999 ** step)) + 1e-8);
      }
      theta[5] = 0;   // the king's value: both sides always have one, so it means nothing
      bake();
    }
  }
  const round = a => [...a].map(x => Number(x.toFixed(3)));
  return {
    values: [...w],
    shape: { advance: round(theta.slice(T, 2 * T)), centre: round(theta.slice(2 * T, 3 * T)) },
    fit: { K: Number(K.toFixed(4)), before: Number(before.toFixed(5)), after: Number(error(K, target).toFixed(5)) },
  };
}
