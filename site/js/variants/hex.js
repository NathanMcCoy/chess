// Gliński's hexagonal chess, through the rules interface (see index.js). Runs in the browser and on
// the server, like chess.js does for standard chess.
//
// The board: 91 hexagons with flat tops, in 11 vertical files a-l (no j), 6 to 11 cells long; f is
// the middle file. Ranks count up each file from its bottom cell, so rank 1 is a chevron with f1 at
// the bottom. Inside, a cell is an axial coordinate (q, r): q is the file (-5 for a to 5 for l), r
// grows downwards within a file; the board is every cell within 5 steps of the centre, f6.
//
// A position ("state") is a FEN-like string: the files a-l separated by "/", each listed from its
// rank 1 upwards (piece letters, digits for runs of empty cells), then the side to move, the en
// passant cell or "-", the half-move clock and the move number. A move is "from" + "to" cells, with a
// promotion letter: "f5f6", "f10f11q".

const FILES = 'abcdefghikl';
const RADIUS = 5;

// --- The board's cells -------------------------------------------------------------------------
const CELLS = [];          // index -> { q, r, file, rank, name, colour }
const INDEX = new Map();   // "q,r" -> index
const BY_NAME = new Map(); // "f6" -> index
for (let q = -RADIUS; q <= RADIUS; q++) {
  const top = Math.max(-RADIUS, -q - RADIUS), bottom = Math.min(RADIUS, -q + RADIUS);
  for (let r = bottom; r >= top; r--) {       // rank 1 is the bottom cell (largest r)
    const rank = bottom - r + 1;
    const name = FILES[q + RADIUS] + rank;
    // Three colours, so a bishop (moving through corners) stays on one: f1, f2 and f3 differ
    const colour = (((q - r) % 3) + 3) % 3;
    INDEX.set(`${q},${r}`, CELLS.length);
    BY_NAME.set(name, CELLS.length);
    CELLS.push({ q, r, file: FILES[q + RADIUS], rank, name, colour });
  }
}
const at = (q, r) => INDEX.get(`${q},${r}`) ?? -1;
const step = (i, [dq, dr]) => at(CELLS[i].q + dq, CELLS[i].r + dr);

// Directions as (dq, dr). Up is towards higher ranks (smaller r).
const EDGES = [[0, -1], [1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0]];       // through a side: rooks
const CORNERS = [[1, -2], [2, -1], [1, 1], [-1, 2], [-2, 1], [-1, -1]];    // through a corner: bishops
const KNIGHT = [[1, -3], [2, -3], [3, -2], [3, -1], [2, 1], [1, 2], [-1, 3], [-2, 3], [-3, 2], [-3, 1], [-2, -1], [-1, -2]];
const PAWN = {   // forward, and the two captures at 60 degrees either side of it
  w: { forward: [0, -1], captures: [[-1, 0], [1, -1]] },
  b: { forward: [0, 1], captures: [[1, 0], [-1, 1]] },
};

const START = {
  w: { K: ['g1'], Q: ['e1'], R: ['c1', 'i1'], N: ['d1', 'h1'], B: ['f1', 'f2', 'f3'], P: ['b1', 'c2', 'd3', 'e4', 'f5', 'g4', 'h3', 'i2', 'k1'] },
};
// Black's start is White's mirrored top to bottom: the same file, rank counted from the other end
const fileLength = f => CELLS.filter(c => c.file === f).length;
const mirror = name => name[0] + (fileLength(name[0]) - Number(name.slice(1)) + 1);
START.b = Object.fromEntries(Object.entries(START.w).map(([t, cells]) => [t, cells.map(mirror)]));
// A pawn may double-step from any of its side's starting cells (also after a capture brought it there)
const PAWN_STARTS = { w: new Set(START.w.P.map(n => BY_NAME.get(n))), b: new Set(START.b.P.map(n => BY_NAME.get(n))) };
// The last cell of each file promotes: the top for White, the bottom for Black
const LAST = { w: new Set(), b: new Set() };
for (const f of FILES) { LAST.w.add(BY_NAME.get(f + fileLength(f))); LAST.b.add(BY_NAME.get(f + '1')); }

const other = c => (c === 'w' ? 'b' : 'w');
const colourOf = p => (p === p.toUpperCase() ? 'w' : 'b');
const typeOf = p => p.toUpperCase();

// --- Positions to and from text ----------------------------------------------------------------
function parse(state) {
  const parts = typeof state === 'string' ? state.trim().split(/\s+/) : [];
  if (parts.length !== 5) return null;
  const [layout, turn, ep, half, full] = parts;
  const files = layout.split('/');
  if (files.length !== FILES.length || !['w', 'b'].includes(turn)) return null;
  const board = new Array(CELLS.length).fill(null);
  for (let f = 0; f < FILES.length; f++) {
    let rank = 1;
    for (const token of files[f].match(/\d+|[KQRBNPkqrbnp]|./g) || []) {
      if (/^\d+$/.test(token)) rank += Number(token);
      else if (/[KQRBNPkqrbnp]/.test(token)) {
        const i = BY_NAME.get(FILES[f] + rank);
        if (i === undefined) return null;
        board[i] = token;
        rank++;
      } else return null;
    }
    if (rank !== fileLength(FILES[f]) + 1) return null;
  }
  const epCell = ep === '-' ? -1 : BY_NAME.get(ep) ?? null;
  if (epCell === null || !/^\d+$/.test(half) || !/^\d+$/.test(full)) return null;
  return { board, turn, ep: epCell, half: Number(half), full: Number(full) };
}

function layoutOf(board) {
  return [...FILES].map(f => {
    let out = '', empty = 0;
    for (let rank = 1; rank <= fileLength(f); rank++) {
      const p = board[BY_NAME.get(f + rank)];
      if (!p) { empty++; continue; }
      if (empty) { out += empty; empty = 0; }
      out += p;
    }
    return out + (empty ? empty : '');
  }).join('/');
}
const format = s => `${layoutOf(s.board)} ${s.turn} ${s.ep < 0 ? '-' : CELLS[s.ep].name} ${s.half} ${s.full}`;

function startPosition() {
  const board = new Array(CELLS.length).fill(null);
  for (const c of ['w', 'b']) {
    for (const [t, cells] of Object.entries(START[c])) for (const n of cells) board[BY_NAME.get(n)] = c === 'w' ? t : t.toLowerCase();
  }
  return { board, turn: 'w', ep: -1, half: 0, full: 1 };
}

// --- Moves ---------------------------------------------------------------------------------------
// Is cell i attacked by side `by`?
function attacked(board, i, by) {
  const is = (j, types) => j >= 0 && board[j] && colourOf(board[j]) === by && types.includes(typeOf(board[j]));
  for (const d of EDGES) {
    if (is(step(i, d), 'K')) return true;
    for (let j = step(i, d); j >= 0; j = step(j, d)) { if (board[j]) { if (is(j, 'RQ')) return true; break; } }
  }
  for (const d of CORNERS) {
    if (is(step(i, d), 'K')) return true;
    for (let j = step(i, d); j >= 0; j = step(j, d)) { if (board[j]) { if (is(j, 'BQ')) return true; break; } }
  }
  for (const d of KNIGHT) if (is(step(i, d), 'N')) return true;
  // A pawn of `by` attacks i if i is one of its capture cells: look back along those directions
  for (const [dq, dr] of PAWN[by].captures) if (is(step(i, [-dq, -dr]), 'P')) return true;
  return false;
}

const kingOf = (board, c) => board.findIndex(p => p === (c === 'w' ? 'K' : 'k'));
const inCheck = s => { const k = kingOf(s.board, s.turn); return k >= 0 && attacked(s.board, k, other(s.turn)); };

// Every move that follows the pieces' rules, before checking it doesn't leave the king in check
function pseudoMoves(s) {
  const { board, turn } = s, out = [];
  const add = (from, to, extra = {}) => out.push({ from, to, ...extra });
  for (let i = 0; i < CELLS.length; i++) {
    const p = board[i];
    if (!p || colourOf(p) !== turn) continue;
    const t = typeOf(p);
    const slide = dirs => {
      for (const d of dirs) for (let j = step(i, d); j >= 0; j = step(j, d)) {
        if (!board[j]) { add(i, j); continue; }
        if (colourOf(board[j]) !== turn) add(i, j, { capture: true });
        break;
      }
    };
    const leap = dirs => {
      for (const d of dirs) { const j = step(i, d); if (j >= 0 && (!board[j] || colourOf(board[j]) !== turn)) add(i, j, { capture: !!board[j] }); }
    };
    if (t === 'R') slide(EDGES);
    else if (t === 'B') slide(CORNERS);
    else if (t === 'Q') slide([...EDGES, ...CORNERS]);
    else if (t === 'K') leap([...EDGES, ...CORNERS]);
    else if (t === 'N') leap(KNIGHT);
    else if (t === 'P') {
      const { forward, captures } = PAWN[turn];
      const pawnTo = (j, extra) => {
        if (LAST[turn].has(j)) for (const promo of 'qrbn') add(i, j, { ...extra, promo });
        else add(i, j, extra);
      };
      const one = step(i, forward);
      if (one >= 0 && !board[one]) {
        pawnTo(one, {});
        const two = step(one, forward);
        if (PAWN_STARTS[turn].has(i) && two >= 0 && !board[two]) add(i, two, { double: one });
      }
      for (const d of captures) {
        const j = step(i, d);
        if (j < 0) continue;
        if (board[j] && colourOf(board[j]) !== turn) pawnTo(j, { capture: true });
        else if (j === s.ep) add(i, j, { capture: true, enPassant: true });
      }
    }
  }
  return out;
}

// The position after a move (no checks: the move is assumed to follow the pieces' rules)
function apply(s, m) {
  const board = s.board.slice();
  const piece = board[m.from];
  board[m.to] = m.promo ? (s.turn === 'w' ? m.promo.toUpperCase() : m.promo) : piece;
  board[m.from] = null;
  if (m.enPassant) board[step(m.to, PAWN[s.turn].forward.map(x => -x))] = null;   // the pawn that went past
  const pawn = typeOf(piece) === 'P';
  return {
    board, turn: other(s.turn), ep: m.double ?? -1,
    half: pawn || m.capture ? 0 : s.half + 1,
    full: s.turn === 'b' ? s.full + 1 : s.full,
  };
}

const legalMoves = s => pseudoMoves(s).filter(m => {
  const after = apply(s, m);
  const k = kingOf(after.board, s.turn);
  return k < 0 || !attacked(after.board, k, after.turn);
});
const moveText = m => CELLS[m.from].name + CELLS[m.to].name + (m.promo || '');

// --- How a move is written: Nf3, exf6, f11=Q, Bf1xc4+ (with the start cell's file, rank or both
// when another piece of the same kind could go there too), # for mate ------------------------------
function nameOf(s, m, legal, after) {
  const piece = typeOf(s.board[m.from]);
  const to = CELLS[m.to].name;
  let text;
  if (piece === 'P') {
    text = (m.capture ? CELLS[m.from].file + 'x' : '') + to + (m.promo ? '=' + m.promo.toUpperCase() : '');
  } else {
    const rivals = legal.filter(o => o.to === m.to && o.from !== m.from && typeOf(s.board[o.from]) === piece);
    let from = '';
    if (rivals.length) {
      const f = CELLS[m.from].file, r = CELLS[m.from].rank;
      if (!rivals.some(o => CELLS[o.from].file === f)) from = f;
      else if (!rivals.some(o => CELLS[o.from].rank === r)) from = String(r);
      else from = CELLS[m.from].name;
    }
    text = piece + from + (m.capture ? 'x' : '') + to;
  }
  if (inCheck(after)) text += legalMoves(after).length ? '+' : '#';
  return text;
}

// --- The end of a game ---------------------------------------------------------------------------
// Checkmate, stalemate (in Gliński's rules not a plain draw: the side giving stalemate scores 3/4,
// the other 1/4), not enough pieces left to mate, the same position three times, or fifty moves each
// with no capture or pawn move. `points` is each side's score when it isn't 1-0, 0-1 or a half each.
function resultOf(s, seen) {
  if (!legalMoves(s).length) {
    if (inCheck(s)) return { winner: other(s.turn), reason: 'checkmate' };
    return { winner: null, reason: 'stalemate', points: { [other(s.turn)]: 0.75, [s.turn]: 0.25 } };
  }
  const left = s.board.filter(p => p && typeOf(p) !== 'K').map(typeOf);
  if (!left.length || (left.length === 1 && 'BN'.includes(left[0]))) return { winner: null, reason: 'material' };
  if ((seen.get(keyOf(s)) || 0) >= 3) return { winner: null, reason: 'repetition' };
  if (s.half >= 100) return { winner: null, reason: 'fifty' };
  return null;
}
const keyOf = s => `${layoutOf(s.board)} ${s.turn} ${s.ep < 0 ? '-' : CELLS[s.ep].name}`;

export default {
  id: 'hex',
  name: 'Hexagonal chess (Gliński)',
  start: () => format(startPosition()),
  turn: state => state.trim().split(/\s+/)[1],
  key: state => { const s = parse(state); return s ? keyOf(s) : state; },
  legal: state => { const s = parse(state); return s ? legalMoves(s).map(moveText) : []; },

  replay(start, moves) {
    let s = parse(start);
    if (!s) return { error: 'not a position', at: -1 };
    const states = [format(s)], names = [];
    const seen = new Map([[keyOf(s), 1]]);
    for (let i = 0; i < moves.length; i++) {
      if (typeof moves[i] !== 'string' || !/^[a-l]\d{1,2}[a-l]\d{1,2}[qrbn]?$/.test(moves[i])) return { error: 'not a move', at: i };
      if (resultOf(s, seen)) return { error: 'the game was already over', at: i };
      const legal = legalMoves(s);
      const m = legal.find(o => moveText(o) === moves[i]);
      if (!m) return { error: 'not a legal move', at: i };
      const after = apply(s, m);
      names.push(nameOf(s, m, legal, after));
      s = after;
      seen.set(keyOf(s), (seen.get(keyOf(s)) || 0) + 1);
      states.push(format(s));
    }
    return { states, names, result: resultOf(s, seen) };
  },

  // For the board drawing (and the tests): the cells, and the cells a promotion happens on
  geometry: { files: FILES, cells: CELLS.map(c => ({ ...c })), last: { w: [...LAST.w].map(i => CELLS[i].name), b: [...LAST.b].map(i => CELLS[i].name) } },
  inCheck: state => { const s = parse(state); return !!s && inCheck(s); },
  // Every piece on the board, as { cell: piece }, for drawing it
  pieces: state => {
    const s = parse(state), out = {};
    if (s) s.board.forEach((p, i) => { if (p) out[CELLS[i].name] = p; });
    return out;
  },
  pieceAt: (state, name) => { const s = parse(state); return s && BY_NAME.has(name) ? s.board[BY_NAME.get(name)] : null; },
};
