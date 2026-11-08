// The site's own bot: it plays any variant through the variant's `engine` (see variants/index.js),
// so the same code plays square and hexagonal chess. It runs in a Web Worker in the browser
// (worker.js), and in Node for the tests.
//
// How it chooses: it looks ahead (alpha-beta search, one move deeper each round until its time is
// up), follows captures to the end so it doesn't stop mid-exchange, and judges the positions it
// reaches with its weights: a value for each kind of piece, plus a bonus or penalty for each kind of
// piece on each cell. Those weights are what it learns, by playing itself: trainer/ (in Rust, about
// 40 times faster than this file; tests/trainer.test.mjs checks it plays and judges exactly as here)
// fits its quick judgement to what its search finds.
//
// Scores are in pawns, from the side to move's point of view. Mate is worth MATE, less the moves
// it takes, so a quicker mate scores higher.

export const TYPES = ['P', 'N', 'B', 'R', 'Q', 'K'];
export const MATE = 1000;
// A result that isn't a win, loss or even draw (Gliński's stalemate: ¾ to the side giving it) is
// scored between them: ¾ is worth STALEMATE pawns
const STALEMATE = 5;
const QUIET_PLY = 32;   // how deep capture sequences are followed, at most
const CHECK_PLY = 16;   // checks make the search look one move further, up to this many moves in

// --- Weights ------------------------------------------------------------------------------------
// A weights file (version 2):
//   values:  the six piece values, then each piece kind's value on each cell (from its own side's
//            point of view: Black's cells are mirrored), for the middle game. The king's piece
//            value is never used.
//   endgame: the same list, for when only kings and pawns are left
//   extras:  { names, middle, end }: what each of the variant's extras (variants/index.js) is worth,
//            in the middle game and the endgame
// The bot blends middle game and endgame by the variant's phase(): 1 at the start, 0 at the end.
// A version 1 file has only `values`: its endgame is the same, and its extras are worth nothing.
export const size = cells => TYPES.length * (1 + cells);
export const valueIndex = t => TYPES.indexOf(t);
export const cellIndex = (t, cell, cells) => TYPES.length + TYPES.indexOf(t) * cells + cell;

export function startingWeights(variantId, cells, extraNames = []) {
  const values = new Array(size(cells)).fill(0);
  Object.entries({ P: 1, N: 3, B: 3, R: 5, Q: 9 }).forEach(([t, v]) => { values[valueIndex(t)] = v; });
  const none = () => new Array(extraNames.length).fill(0);
  return { variant: variantId, version: 2, cells, generation: 0, values, endgame: [...values], extras: { names: [...extraNames], middle: none(), end: none() } };
}

// How good the position is for White, in pawns. (The Rust trainer adds it up in the same order, so
// the two agree to the last digit: tests/trainer.test.mjs checks it.)
export function evaluate(e, pos, w) {
  const v = w.values, end = w.endgame || v, cells = w.cells;
  let mg = 0, eg = 0;
  for (const [t, i, c] of e.pieces(pos)) {
    const k = TYPES.indexOf(t);
    const at = TYPES.length + k * cells + (c === 'w' ? i : e.mirror(i));
    const s = c === 'w' ? 1 : -1;
    mg += s * (v[k] + v[at]);
    eg += s * (end[k] + end[at]);
  }
  const ph = e.phase ? e.phase(pos) : 1;
  let score = mg * ph + eg * (1 - ph);
  const x = w.extras && e.extras ? e.extras(pos) : [];
  if (x.length && w.extras.middle?.length === x.length) {
    for (let k = 0; k < x.length; k++) score += (w.extras.middle[k] * ph + w.extras.end[k] * (1 - ph)) * x[k];
  }
  return score;
}

// A weights file made ready for this variant's engine, or null if it can't be used. Its extras are
// matched to the engine's by name, so a file made before an extra was added still loads (the new
// one worth nothing until it's learned), and a version 1 file gets an endgame the same as its middle.
export function prepare(w, e) {
  const n = size(e.cells);
  if (!w || !Array.isArray(w.values) || w.values.length !== n) return null;
  if (w.endgame !== undefined && !(Array.isArray(w.endgame) && w.endgame.length === n)) return null;
  const names = e.extraNames || [];
  const middle = names.map(() => 0), end = names.map(() => 0);
  const ex = w.extras;
  if (ex !== undefined) {
    const ok = ex && Array.isArray(ex.names) && Array.isArray(ex.middle) && Array.isArray(ex.end)
      && ex.middle.length === ex.names.length && ex.end.length === ex.names.length;
    if (!ok) return null;
    names.forEach((name, k) => { const at = ex.names.indexOf(name); if (at >= 0) { middle[k] = ex.middle[at]; end[k] = ex.end[at]; } });
  }
  return { ...w, endgame: w.endgame || [...w.values], extras: { names: [...names], middle, end } };
}

// --- The search ---------------------------------------------------------------------------------
const STOP = Symbol('out of time');
const VALUE = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };   // for trying the best captures first

// The game so far, through the variant's engine: the current position, and every earlier one's key
// (a position seen before in the game counts as a draw if the search comes back to it)
export function position(v, start, moves) {
  const e = v.engine;
  let pos = e.from(start);
  if (!pos) throw new Error('not a position');
  const seen = new Set([e.key(pos)]);
  for (const text of moves) {
    const m = e.moves(pos).find(o => e.text(o) === text);
    if (!m) throw new Error(`not a legal move: ${text}`);
    pos = e.play(pos, m);
    seen.add(e.key(pos));
  }
  return { pos, seen };
}

// Chooses a move for the side to move in `start` + `moves` (or in `pos`, with `seen` the keys of
// every earlier position, as position() gives them: training keeps those as it goes).
// options: timeMs (default 1000), maxDepth, maxNodes, now (a clock, for the tests)
// Gives { move, score, depth, nodes, line }, or { move: null } when the game is over.
export function chooseMove(v, game, weights, options = {}) {
  const e = v.engine;
  const { timeMs = 1000, maxDepth = 64, maxNodes = Infinity, now = () => Date.now() } = options;
  const { pos: root, seen } = game.pos ? game : position(v, game.start, game.moves || []);
  const deadline = now() + timeMs;
  const table = new Map();   // key -> { depth, score, flag, best }
  let nodes = 0;

  const judge = pos => (e.turn(pos) === 'w' ? 1 : -1) * evaluate(e, pos, weights);
  const terminal = (pos, ply) => {
    const r = e.noMoves(pos);
    if (r.winner) return -(MATE - ply);   // the side to move is mated
    const mine = r.points ? r.points[e.turn(pos)] : 0.5;
    return (mine - 0.5) * 4 * STALEMATE;  // ¼ scores -STALEMATE, an even draw 0
  };
  const tick = () => {
    nodes++;
    if ((nodes & 63) === 0 && now() > deadline) throw STOP;   // often: a chess.js position is slow
    if (nodes >= maxNodes) throw STOP;
  };
  // Captures first, the most valuable victims first; then promotions; then the rest
  const order = (pos, list, best) => {
    const rank = m => {
      if (best && e.text(m) === best) return 1e6;
      const c = e.captured(pos, m), p = e.promotion(m);
      return (c ? 100 + 10 * VALUE[c] : 0) + (p ? 50 + VALUE[p] : 0);
    };
    return list.map(m => [rank(m), m]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  };

  function quiet(pos, alpha, beta, ply) {
    tick();
    const list = e.moves(pos);
    if (!list.length) return terminal(pos, ply);
    if (e.drawn(pos)) return 0;
    const stand = judge(pos);
    if (stand >= beta || ply >= QUIET_PLY) return stand;
    if (stand > alpha) alpha = stand;
    for (const m of order(pos, list.filter(x => e.captured(pos, x) || e.promotion(x)))) {
      const score = -quiet(e.play(pos, m), -beta, -alpha, ply + 1);
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  function search(pos, depth, alpha, beta, ply, path) {
    tick();
    const key = e.key(pos);
    if (ply > 0 && (path.has(key) || seen.has(key))) return 0;   // back to an earlier position
    if (e.drawn(pos)) return 0;
    const list = e.moves(pos);
    if (!list.length) return terminal(pos, ply);
    const check = e.inCheck(pos);
    if (check && ply < CHECK_PLY) depth++;   // look further when the king is attacked: it finds mates sooner
    if (depth <= 0) return quiet(pos, alpha, beta, ply);

    const known = table.get(key);
    if (known && known.depth >= depth) {
      if (known.flag === 0) return known.score;
      if (known.flag < 0 && known.score <= alpha) return known.score;
      if (known.flag > 0 && known.score >= beta) return known.score;
    }
    const start = alpha;
    let best = -Infinity, bestMove = null;
    path.add(key);
    for (const m of order(pos, list, known?.best)) {
      const score = -search(e.play(pos, m), depth - 1, -beta, -alpha, ply + 1, path);
      if (score > best) { best = score; bestMove = e.text(m); }
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    path.delete(key);
    if (table.size > 200000) table.clear();
    table.set(key, { depth, score: best, best: bestMove, flag: best <= start ? -1 : best >= beta ? 1 : 0 });
    return best;
  }

  // One move deeper each round; a round cut off by the clock is thrown away
  const rootMoves = e.moves(root);
  if (!rootMoves.length) return { move: null, score: terminal(root, 0), depth: 0, nodes: 0, line: [] };
  let result = { move: e.text(order(root, rootMoves)[0]), score: 0, depth: 0, nodes: 0 };
  try {
    for (let depth = 1; depth <= maxDepth; depth++) {
      let alpha = -Infinity, bestMove = null;
      const path = new Set([e.key(root)]);
      for (const m of order(root, rootMoves, result.move)) {
        const score = -search(e.play(root, m), depth - 1, -Infinity, -alpha, 1, path);
        if (score > alpha) { alpha = score; bestMove = e.text(m); }
      }
      result = { move: bestMove, score: alpha, depth, nodes };
      if (Math.abs(alpha) > MATE - 100) break;   // a forced mate found: looking deeper won't change it
    }
  } catch (err) {
    if (err !== STOP) throw err;
  }
  return { ...result, nodes, line: principal(e, root, result.move, table) };
}

// The moves the bot expects, as far as its table knows them (for showing what it's thinking)
function principal(e, pos, first, table) {
  const line = [];
  let move = first;
  const keys = new Set();
  while (move && line.length < 12) {
    const m = e.moves(pos).find(o => e.text(o) === move);
    if (!m) break;
    line.push(move);
    pos = e.play(pos, m);
    const key = e.key(pos);
    if (keys.has(key)) break;
    keys.add(key);
    move = table.get(key)?.best;
  }
  return line;
}
