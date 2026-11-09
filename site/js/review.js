// The game review's arithmetic, with no board or page code, so it can be tested on its own
// (tests/review.test.mjs). An evaluation from the engine becomes a win chance, and each move is
// rated by how much of the mover's win chance it gave away.

// The ratings, best first. `loss` is the most win chance (in percentage points) a move may give
// away and still get the rating; "best" means the engine's own first choice. `symbol` is the
// standard chess annotation written after the move (g4??); `badge` is what its little badge shows.
export const RATINGS = [
  { id: 'best', label: 'Best', symbol: '', badge: '★', loss: 0 },
  { id: 'excellent', label: 'Excellent', symbol: '', badge: '!', loss: 3 },
  { id: 'good', label: 'Good', symbol: '', badge: '✓', loss: 10 },
  { id: 'inaccuracy', label: 'Inaccuracy', symbol: '?!', badge: '?!', loss: 20 },
  { id: 'mistake', label: 'Mistake', symbol: '?', badge: '?', loss: 30 },
  { id: 'blunder', label: 'Blunder', symbol: '??', badge: '??', loss: Infinity },
];
export const RATING = Object.fromEntries(RATINGS.map(r => [r.id, r]));

// Win chance (0 to 100) for the side to move, from an engine score from its point of view. The
// curve is the one Lichess publishes (fitted to real games): +1 pawn is about 59%, +3 about 75%.
// A forced mate is 100 for the side giving it and 0 for the side receiving it ({ mate: 0 } = mated).
// `k` is how steep the curve is, per hundredth of a pawn: CHESS_K, or HEX_K for hexagonal chess.
export const CHESS_K = 0.00368208;
// Fitted to 3.6 million positions of the hex bot's own games, scored by its neural network
// (Nov 8): +1 pawn wins about 57%, +3 about 69%. Its pawns win less often than chess's do.
export const HEX_K = 0.0027;
export function winChance(score, k = CHESS_K) {
  if (!score) return 50;
  if ('mate' in score) return score.mate > 0 ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-k * score.cp)) - 1);
}

// The same, always from White's point of view (for the bar and the graph)
export const whiteChance = (score, turn, k = CHESS_K) => (turn === 'w' ? winChance(score, k) : 100 - winChance(score, k));

// The hex bot's score (bot.js and the WebAssembly engine: pawns for the side to move, a mate
// MATE less the plies to it) as the review counts scores: { cp } or { mate } in moves
export const MATE = 1000;
export function fromPawns(s) {
  if (Math.abs(s) > MATE - 200) {
    const plies = Math.round(MATE - Math.abs(s));
    return { mate: s > 0 ? Math.ceil(plies / 2) : -Math.ceil(plies / 2) };
  }
  return { cp: Math.round(s * 100) };
}

// One move's rating. `before` and `after` are the analysed positions either side of it
// ({ score, turn, best }), `uci` the move played, `legal` how many moves were possible.
export function rate(before, after, uci, legal = 2, k = CHESS_K) {
  const mover = before.turn;
  const chanceBefore = whiteChance(before.score, before.turn, k);
  const chanceAfter = whiteChance(after.score, after.turn, k);
  const loss = Math.max(0, mover === 'w' ? chanceBefore - chanceAfter : chanceAfter - chanceBefore);
  let rating;
  if (uci === before.best || legal === 1) rating = 'best';   // the engine's choice, or the only move there was
  else rating = RATINGS.find(r => r.id !== 'best' && loss < r.loss).id;
  return { rating, loss, forced: legal === 1 };
}

// Accuracy (0 to 100) of a set of moves, from the win chance each gave away. Per move, the curve
// Lichess publishes (no loss = 100, a 10-point loss about 64, a 30-point loss about 25); for the
// game, the average of the plain mean and the harmonic mean, so a few bad moves pull it down more
// than many fine ones push it up.
export function moveAccuracy(loss) {
  return Math.min(100, Math.max(0, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
}
export function accuracy(losses) {
  if (!losses.length) return null;
  const each = losses.map(moveAccuracy);
  const mean = each.reduce((a, b) => a + b, 0) / each.length;
  const harmonic = each.length / each.reduce((a, b) => a + 1 / Math.max(b, 1), 0);
  return (mean + harmonic) / 2;
}

// An evaluation as people write it, from White's point of view: "+1.3", "−0.4", "0.0", "M3", "−M2"
export function evalText(score, turn) {
  if (!score) return '';
  const sign = turn === 'w' ? 1 : -1;
  if ('mate' in score) {
    const m = score.mate * sign;
    if (score.mate === 0) return turn === 'w' ? '0-1' : '1-0';   // the side to move has been mated
    return `${m > 0 ? '' : '−'}M${Math.abs(m)}`;
  }
  const v = (score.cp * sign) / 100;
  return v === 0 ? '0.0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
}
