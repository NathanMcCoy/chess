// The board for hexagonal chess: 91 hexagons drawn in SVG, with the cburnett pieces (the same
// pictures chessground uses for square chess) laid over it. It knows nothing about the rules: the
// page tells it where the pieces are and which moves are allowed, and hears back which move was made.
//
//   const board = hexBoard(element, { geometry, onMove(from, to) });
//   board.set({ pieces: { f1: 'B', ... }, dests: { e4: ['e5', 'e6'] }, lastMove: ['e4', 'e5'],
//               check: 'g10', orientation: 'w' | 'b' });
//
// Moving: tap (or click) a piece, then the cell to go to; or drag it there. Taps are placed by where
// the board is at that moment, so the page moving the board around never makes them land wrong.
// Each cell is an SVG polygon with data-cell="f6", which the tests use to find it on screen.

const NS = 'http://www.w3.org/2000/svg';
const SQRT3 = Math.sqrt(3);
// The drawing's own units: a hexagon is 1 from its centre to a corner. Room round the edge for labels.
const VIEW = { x: -9.5, y: -10.6, w: 19, h: 21.2 };
const PIECE = 1.42;   // a piece's size, a little less than the hexagon's height (1.73)
const NAMES = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };

const el = (name, attrs = {}, parent) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
};
const corners = (x, y, size = 1) => Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 3) * i;   // flat-topped: corners at 0, 60, ... degrees
  return `${(x + size * Math.cos(a)).toFixed(3)},${(y + size * Math.sin(a)).toFixed(3)}`;
}).join(' ');

export function hexBoard(root, { geometry, onMove }) {
  const cells = geometry.cells;
  const byName = new Map(cells.map(c => [c.name, c]));
  let state = { pieces: {}, dests: {}, lastMove: null, check: null, orientation: 'w' };
  let selected = null, drag = null;

  root.classList.add('hexboard');
  root.replaceChildren();
  const svg = el('svg', { viewBox: `${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`, class: 'hex-svg', role: 'img', 'aria-label': 'Hexagonal chess board' }, root);
  const cellLayer = el('g', {}, svg), markLayer = el('g', { class: 'hex-marks' }, svg), labelLayer = el('g', { class: 'hex-labels' }, svg);
  const pieceLayer = document.createElement('div');
  pieceLayer.className = 'cg-wrap hex-pieces';
  root.append(pieceLayer);

  // Where a cell's centre is drawn, with White at the bottom or (turned round) Black
  const spot = c => {
    const x = 1.5 * c.q, y = SQRT3 * (c.r + c.q / 2);
    return state.orientation === 'b' ? { x: -x, y: -y } : { x, y };
  };
  const polys = new Map();
  for (const c of cells) polys.set(c.name, el('polygon', { class: `hex-cell c${c.colour}`, 'data-cell': c.name }, cellLayer));

  function layout() {
    for (const c of cells) { const { x, y } = spot(c); polys.get(c.name).setAttribute('points', corners(x, y, 0.995)); }
    labelLayer.replaceChildren();
    // Files under each file's lowest cell on screen; ranks to the left of each rank's leftmost cell
    const files = new Map(), ranks = new Map();
    for (const c of cells) {
      const p = spot(c);
      if (!files.has(c.file) || p.y > files.get(c.file).y) files.set(c.file, p);
      if (!ranks.has(c.rank) || p.x < ranks.get(c.rank).x) ranks.set(c.rank, p);
    }
    for (const [f, p] of files) el('text', { x: p.x, y: p.y + SQRT3 / 2 + 0.55, class: 'hex-label' }, labelLayer).textContent = f;
    for (const [r, p] of ranks) el('text', { x: p.x - 1.35, y: p.y - 0.35, class: 'hex-label' }, labelLayer).textContent = r;
  }

  function draw() {
    // Highlights go over the cells, see-through, so each cell keeps its own colour under them
    markLayer.replaceChildren();
    const mark = (name, kind) => {
      const c = byName.get(name);
      if (!c) return;
      const { x, y } = spot(c);
      el('polygon', { points: corners(x, y, 0.995), class: `hex-mark ${kind}`, 'data-mark': `${kind} ${name}` }, markLayer);
    };
    for (const name of state.lastMove || []) mark(name, 'last');
    if (selected) mark(selected, 'selected');
    if (state.check) mark(state.check, 'check');
    for (const to of (selected && state.dests[selected]) || []) {
      const { x, y } = spot(byName.get(to));
      if (state.pieces[to]) el('polygon', { points: corners(x, y, 0.86), class: 'hex-dest capture', 'data-dest': to }, markLayer);
      else el('circle', { cx: x, cy: y, r: 0.3, class: 'hex-dest', 'data-dest': to }, markLayer);
    }
    pieceLayer.replaceChildren();
    for (const [name, p] of Object.entries(state.pieces)) {
      const c = byName.get(name);
      if (!c) continue;
      const { x, y } = spot(c);
      const piece = document.createElement('piece');
      piece.className = `${p === p.toUpperCase() ? 'white' : 'black'} ${NAMES[p.toUpperCase()]}`;
      piece.dataset.cell = name;
      piece.style.width = `${(PIECE / VIEW.w) * 100}%`;
      piece.style.height = `${(PIECE / VIEW.h) * 100}%`;
      piece.style.left = `${((x - PIECE / 2 - VIEW.x) / VIEW.w) * 100}%`;
      piece.style.top = `${((y - PIECE / 2 - VIEW.y) / VIEW.h) * 100}%`;
      if (drag?.from === name && drag.moved) { piece.classList.add('dragging'); drag.el = piece; placeDrag(); }
      pieceLayer.append(piece);
    }
  }

  // The cell under a point on screen, or null: the nearest centre, if it's inside that hexagon
  function cellAt(clientX, clientY) {
    const box = svg.getBoundingClientRect();
    const scale = Math.min(box.width / VIEW.w, box.height / VIEW.h);
    const x = (clientX - box.left - (box.width - VIEW.w * scale) / 2) / scale + VIEW.x;
    const y = (clientY - box.top - (box.height - VIEW.h * scale) / 2) / scale + VIEW.y;
    let best = null, dist = Infinity;
    for (const c of cells) {
      const p = spot(c), d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < dist) { dist = d; best = c; }
    }
    return dist <= 0.9 ? best.name : null;   // within the hexagon's inner circle (0.87) and a little
  }
  const movable = name => !!state.dests[name]?.length;
  function placeDrag() {
    if (!drag?.el) return;
    const box = root.getBoundingClientRect();
    drag.el.style.left = `${drag.x - box.left - drag.el.offsetWidth / 2}px`;
    drag.el.style.top = `${drag.y - box.top - drag.el.offsetHeight / 2}px`;
  }
  function tryMove(from, to) {
    selected = null;
    if (state.dests[from]?.includes(to)) { onMove(from, to); return true; }
    return false;
  }

  root.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const name = cellAt(e.clientX, e.clientY);
    if (selected && name && name !== selected && state.dests[selected]?.includes(name)) { e.preventDefault(); tryMove(selected, name); draw(); return; }
    if (name && movable(name)) {
      e.preventDefault();
      const wasSelected = selected === name;
      selected = name;
      drag = { from: name, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false, wasSelected, id: e.pointerId };
      root.setPointerCapture?.(e.pointerId);
    } else selected = null;
    draw();
  });
  root.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.moved && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 6) { drag.moved = true; draw(); }
    placeDrag();
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (d.moved) {
      const to = cellAt(e.clientX, e.clientY);
      if (!(to && to !== d.from && tryMove(d.from, to))) selected = to === d.from ? d.from : null;
    } else if (d.wasSelected) selected = null;   // a second tap on the same piece puts it down
    draw();
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.id) { drag = null; draw(); } });
  // An iPhone still zoomed in on a quick second tap with the page's touch-action: manipulation (the
  // user's, Nov 7). Cancelling the pointer events doesn't stop it; cancelling the touch's end does.
  // Taps still work: they're read from the pointer events above, which come first.
  root.addEventListener('touchend', e => e.preventDefault(), { passive: false });

  layout();
  draw();
  return {
    set(next) {
      const turned = next.orientation && next.orientation !== state.orientation;
      state = { ...state, ...next };
      if (selected && !movable(selected)) selected = null;
      if (turned) layout();
      draw();
    },
    get orientation() { return state.orientation; },
  };
}
