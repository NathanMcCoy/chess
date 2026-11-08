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

// Directions as (dq, dr). Up is towards higher ranks (smaller r).
const EDGES = [[0, -1], [1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0]];       // through a side: rooks
const CORNERS = [[1, -2], [2, -1], [1, 1], [-1, 2], [-2, 1], [-1, -1]];    // through a corner: bishops
const KNIGHT = [[1, -3], [2, -3], [3, -2], [3, -1], [2, 1], [1, 2], [-1, 3], [-2, 3], [-3, 2], [-3, 1], [-2, -1], [-1, -2]];
const back = ([dq, dr]) => [-dq, -dr];
const PAWN = {   // forward, and the two captures at 60 degrees either side of it (and the way back)
  w: { forward: [0, -1], captures: [[-1, 0], [1, -1]] },
  b: { forward: [0, 1], captures: [[1, 0], [-1, 1]] },
};
for (const p of Object.values(PAWN)) { p.backward = back(p.forward); p.from = p.captures.map(back); }

// The cell one step from cell i in direction d, or -1 off the board. Worked out once for every
// direction above, as a table: a bot looks at thousands of positions a second, and building a text
// key for every step took a fifth of its time.
// The table is kept on the direction itself (d.next), so a step is one array read.
for (const d of [...EDGES, ...CORNERS, ...KNIGHT, ...Object.values(PAWN).flatMap(p => [p.forward, p.backward, ...p.captures, ...p.from])]) {
  d.next = Int16Array.from(CELLS, c => at(c.q + d[0], c.r + d[1]));
}
const step = (i, d) => d.next[i];

const START = {
  w: { K: ['g1'], Q: ['e1'], R: ['c1', 'i1'], N: ['d1', 'h1'], B: ['f1', 'f2', 'f3'], P: ['b1', 'c2', 'd3', 'e4', 'f5', 'g4', 'h3', 'i2', 'k1'] },
};
// Black's start is White's mirrored top to bottom: the same file, rank counted from the other end
const FILE_LENGTH = Object.fromEntries([...FILES].map(f => [f, CELLS.filter(c => c.file === f).length]));
const fileLength = f => FILE_LENGTH[f];
const mirror = name => name[0] + (fileLength(name[0]) - Number(name.slice(1)) + 1);
START.b = Object.fromEntries(Object.entries(START.w).map(([t, cells]) => [t, cells.map(mirror)]));
// A pawn may double-step from any of its side's starting cells (also after a capture brought it there)
const PAWN_STARTS = { w: new Set(START.w.P.map(n => BY_NAME.get(n))), b: new Set(START.b.P.map(n => BY_NAME.get(n))) };
// The last cell of each file promotes: the top for White, the bottom for Black
const LAST = { w: new Set(), b: new Set() };
for (const f of FILES) { LAST.w.add(BY_NAME.get(f + fileLength(f))); LAST.b.add(BY_NAME.get(f + '1')); }

const other = c => (c === 'w' ? 'b' : 'w');
const colourOf = p => (p < 'a' ? 'w' : 'b');   // capitals sort before small letters: White's pieces
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
  for (const d of PAWN[by].from) if (is(step(i, d), 'P')) return true;
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
  if (m.enPassant) board[step(m.to, PAWN[s.turn].backward)] = null;   // the pawn that went past
  const pawn = typeOf(piece) === 'P';
  return {
    board, turn: other(s.turn), ep: m.double ?? -1,
    half: pawn || m.capture ? 0 : s.half + 1,
    full: s.turn === 'b' ? s.full + 1 : s.full,
  };
}

const legalMoves = s => {
  const king = kingOf(s.board, s.turn);   // found once: it's only somewhere else if it's the piece moving
  return pseudoMoves(s).filter(m => {
    const after = apply(s, m);
    const k = m.from === king ? m.to : king;
    return k < 0 || !attacked(after.board, k, after.turn);
  });
};
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

// --- For bots: fast play on this file's own positions and moves (see index.js) -------------------
// Each cell seen from Black's side: the same file, the rank counted from the other end
const MIRROR = CELLS.map(c => BY_NAME.get(mirror(c.name)));
// How far up the board each cell is for White (0 at the bottom corner, 1 at the top), and how near the
// middle (1 at f6, 0 round the edge): flat-topped cells, so a cell's height is r + q / 2
const HEIGHT = CELLS.map(c => c.r + c.q / 2), LOW = Math.min(...HEIGHT), HIGH = Math.max(...HEIGHT);
const CELL_INFO = CELLS.map((c, i) => [(HIGH - HEIGHT[i]) / (HIGH - LOW), 1 - Math.max(Math.abs(c.q), Math.abs(c.r), Math.abs(c.q + c.r)) / RADIUS]);

// What the bot judges besides where each piece stands (bot.js), each as White's less Black's. The Rust
// trainer (trainer/src/hex.rs) works out the same numbers, and tests/trainer.test.mjs checks they match.
//   mobility N, B, R, Q, K: the cells that kind of piece could move to (empty or an enemy's), ignoring
//     whether the move would leave the king in check
//   passed pawns: pawns with no enemy pawn further up their own file or the files either side (where
//     one could block or take them); and the same pawns, each counted by how far up it is (0 to 1)
//   pawns by the king: a side's own pawns on the six cells next to its king (through the sides)
//   pieces near the enemy king: knights, bishops, rooks and queens within two steps of it
const EXTRAS = ['mobility N', 'mobility B', 'mobility R', 'mobility Q', 'mobility K', 'passed pawns', 'passed pawns, how far up', 'pawns by the king', 'pieces near the enemy king'];
const hexDistance = (i, j) => { const dq = CELLS[j].q - CELLS[i].q, dr = CELLS[j].r - CELLS[i].r; return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)); };
const NEAR = CELLS.map((_, i) => CELLS.map((_, j) => j).filter(j => j !== i && hexDistance(i, j) <= 2));
// For a pawn of each side on each cell, the cells an enemy pawn would have to be on to stop it
// being passed: one file either side or its own, further up (from that side's point of view)
const FRONT = {
  w: CELLS.map((c, i) => CELLS.map((_, j) => j).filter(j => Math.abs(CELLS[j].q - c.q) <= 1 && HEIGHT[j] < HEIGHT[i])),
  b: CELLS.map((c, i) => CELLS.map((_, j) => j).filter(j => Math.abs(CELLS[j].q - c.q) <= 1 && HEIGHT[j] > HEIGHT[i])),
};
// How much material is left, for blending middle-game and endgame values: knights and bishops 1,
// rooks 2, queens 4, so the start (both sides) is 26
const PHASE = { N: 1, B: 1, R: 2, Q: 4 }, PHASE_START = 26;
function extras(s) {
  const b = s.board;
  // The cells a piece on i could move to in directions `dirs` (all the way along them if it slides)
  const reach = (i, c, dirs, slides) => {
    let n = 0;
    for (const d of dirs) {
      for (let j = step(i, d); j >= 0; j = slides ? step(j, d) : -1) {
        if (!b[j]) { n++; continue; }
        if (colourOf(b[j]) !== c) n++;
        break;
      }
    }
    return n;
  };
  const mob = { w: [0, 0, 0, 0, 0], b: [0, 0, 0, 0, 0] };
  const passed = { w: 0, b: 0 }, far = { w: 0, b: 0 };
  for (let i = 0; i < CELLS.length; i++) {
    const p = b[i];
    if (!p) continue;
    const c = colourOf(p), t = typeOf(p);
    if (t === 'N') mob[c][0] += reach(i, c, KNIGHT, false);
    else if (t === 'B') mob[c][1] += reach(i, c, CORNERS, true);
    else if (t === 'R') mob[c][2] += reach(i, c, EDGES, true);
    else if (t === 'Q') mob[c][3] += reach(i, c, EDGES, true) + reach(i, c, CORNERS, true);
    else if (t === 'K') mob[c][4] += reach(i, c, EDGES, false) + reach(i, c, CORNERS, false);
    else if (!FRONT[c][i].some(j => b[j] === (c === 'w' ? 'p' : 'P'))) {
      passed[c]++;
      far[c] += CELL_INFO[c === 'w' ? i : MIRROR[i]][0];
    }
  }
  const shield = c => { const k = kingOf(b, c); return k < 0 ? 0 : EDGES.filter(d => { const j = step(k, d); return j >= 0 && b[j] === (c === 'w' ? 'P' : 'p'); }).length; };
  const near = c => {   // the enemy's pieces near side c's king
    const k = kingOf(b, c);
    return k < 0 ? 0 : NEAR[k].filter(j => b[j] && colourOf(b[j]) !== c && 'NBRQ'.includes(typeOf(b[j]))).length;
  };
  return [...mob.w.map((x, k) => x - mob.b[k]), passed.w - passed.b, far.w - far.b, shield('w') - shield('b'), near('b') - near('w')];
}

const engine = {
  extraNames: EXTRAS,
  extras,
  phase: s => {
    let n = 0;
    for (const p of s.board) if (p) n += PHASE[typeOf(p)] || 0;
    return Math.min(1, n / PHASE_START);
  },
  cells: CELLS.length,
  mirror: i => MIRROR[i],
  cellInfo: i => CELL_INFO[i],
  from: state => parse(state),
  state: s => format(s),
  moves: s => legalMoves(s),
  play: (s, m) => apply(s, m),
  text: m => moveText(m),
  turn: s => s.turn,
  key: s => `${s.board.join(',')}${s.turn}${s.ep}`,   // cheaper than keyOf, and the same when positions are
  inCheck: s => inCheck(s),
  // The piece a move takes ('P'..'Q'), or null; a promotion counts as gaining its piece
  captured: (s, m) => (m.enPassant ? 'P' : s.board[m.to] ? typeOf(s.board[m.to]) : null),
  promotion: m => (m.promo ? m.promo.toUpperCase() : null),
  pieces: s => {
    const out = [];
    for (let i = 0; i < CELLS.length; i++) if (s.board[i]) out.push([typeOf(s.board[i]), i, colourOf(s.board[i])]);
    return out;
  },
  // A draw whatever happens next: too few pieces to mate, or fifty moves with no capture or pawn move
  drawn: s => {
    if (s.half >= 100) return true;
    const left = s.board.filter(p => p && typeOf(p) !== 'K').map(typeOf);
    return !left.length || (left.length === 1 && 'BN'.includes(left[0]));
  },
  // The result when the side to move has no moves: checkmate, or Gliński's stalemate (¾ to the giver)
  noMoves: s => (inCheck(s) ? { winner: other(s.turn), reason: 'checkmate' }
    : { winner: null, reason: 'stalemate', points: { [other(s.turn)]: 0.75, [s.turn]: 0.25 } }),
};

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
  engine,
};
