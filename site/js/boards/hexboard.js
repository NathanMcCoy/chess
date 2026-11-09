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
//
// Arrows and circles, as chessground draws them on the square board: drag with the right mouse
// button (or Shift and the left) from one cell to another for an arrow, or let go on the same cell
// for a circle. Green; red with Shift or Ctrl; blue with Alt; yellow with both. Drawing the same
// shape again takes it away, and a plain click on the board clears them all. The page can draw its
// own (the review's best move and badges) with setAutoShapes([{ orig, dest, brush } | { orig, badge:
// { rating, text } }]); those stay until it changes them. Each shape has data-shape="arrow f2 f4 green".

const NS = 'http://www.w3.org/2000/svg';
const SQRT3 = Math.sqrt(3);
// The drawing's own units: a hexagon is 1 from its centre to a corner. Room round the edge for labels.
const VIEW = { x: -9.5, y: -10.6, w: 19, h: 21.2 };
const PIECE = 1.42;   // a piece's size, a little less than the hexagon's height (1.73)
const NAMES = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };
const BRUSHES = ['green', 'red', 'blue', 'yellow'];   // in chessground's order: + 1 for Shift/Ctrl, + 2 for Alt
const LINE = 0.17;                                    // an arrow's width (chessground's 10 in a 100 square)
const brushFor = e => BRUSHES[((e.shiftKey || e.ctrlKey) && e.button === 2 ? 1 : 0) + (e.altKey || e.metaKey ? 2 : 0)];

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
  let shapes = [], autoShapes = [], drawing = null;   // the user's, the page's, and one being drawn

  root.classList.add('hexboard');
  root.replaceChildren();
  const svg = el('svg', { viewBox: `${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`, class: 'hex-svg', role: 'img', 'aria-label': 'Hexagonal chess board' }, root);
  const cellLayer = el('g', {}, svg), markLayer = el('g', { class: 'hex-marks' }, svg), labelLayer = el('g', { class: 'hex-labels' }, svg);
  const pieceLayer = document.createElement('div');
  pieceLayer.className = 'cg-wrap hex-pieces';
  root.append(pieceLayer);
  // Over the pieces (as chessground's are), in the same units as the board's drawing
  const shapeSvg = el('svg', { viewBox: `${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`, class: 'hex-shapes', 'aria-hidden': 'true' }, root);
  const defs = el('defs', {}, shapeSvg);
  for (const brush of BRUSHES) {
    const m = el('marker', { id: `hex-head-${brush}`, orient: 'auto', markerWidth: 4, markerHeight: 4, refX: 2.05, refY: 2, class: `brush-${brush}` }, defs);
    el('path', { d: 'M0,0 V4 L3,2 Z' }, m);
  }
  const shapeLayer = el('g', {}, shapeSvg);

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
    drawShapes();
  }

  // Arrows, circles and badges: the page's, then the user's, then the one being drawn (fainter)
  function drawShapes() {
    shapeLayer.replaceChildren();
    const current = drawing && { orig: drawing.orig, dest: drawing.dest, brush: drawing.brush, current: true };
    for (const s of [...autoShapes, ...shapes, ...(current ? [current] : [])]) {
      const a = byName.get(s.orig);
      if (!a) continue;
      const p = spot(a);
      if (s.badge) {
        // The review's badge, in the corner of the cell: the square board's drawing (a 100 × 100
        // box over the square, .sq-badge in app.css) scaled to a box round the hexagon
        const size = SQRT3;
        const g = el('g', { class: 'sq-badge', 'data-rating': s.badge.rating, 'data-shape': `badge ${s.orig} ${s.badge.rating}`,
          transform: `translate(${(p.x - size / 2).toFixed(3)} ${(p.y - size / 2).toFixed(3)}) scale(${(size / 100).toFixed(5)})` }, shapeLayer);
        el('circle', { cx: 82, cy: 18, r: 17 }, g);
        el('text', { x: 82, y: 19 }, g).textContent = s.badge.text;
        continue;
      }
      const brush = BRUSHES.includes(s.brush) ? s.brush : 'green';
      const cls = `hex-shape brush-${brush}${s.current ? ' current' : ''}`;
      const b = s.dest && s.dest !== s.orig && byName.get(s.dest);
      if (!b) {
        el('circle', { cx: p.x, cy: p.y, r: 0.87 - LINE / 2, class: cls, 'stroke-width': LINE * 0.6, 'data-shape': `circle ${s.orig} ${brush}` }, shapeLayer);
        continue;
      }
      // The line stops short of the far cell's centre by the arrowhead's length, so its tip lands there
      const q = spot(b), d = Math.hypot(q.x - p.x, q.y - p.y), back = LINE * 1.9;
      const x2 = q.x - ((q.x - p.x) / d) * back, y2 = q.y - ((q.y - p.y) / d) * back;
      el('line', { x1: p.x, y1: p.y, x2, y2, class: cls, 'stroke-width': LINE, 'stroke-linecap': 'round',
        'marker-end': `url(#hex-head-${brush})`, 'data-shape': `arrow ${s.orig} ${s.dest} ${brush}` }, shapeLayer);
    }
  }

  // A finished drawing: the same shape again takes it away; in another colour, it's replaced
  function toggleShape(s) {
    const same = x => x.orig === s.orig && (x.dest || null) === (s.dest || null);
    const had = shapes.find(same);
    shapes = shapes.filter(x => !same(x));
    if (!had || had.brush !== s.brush) shapes.push(s);
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

  // Drawing: the right button, or Shift with the left (as chessground)
  root.addEventListener('contextmenu', e => e.preventDefault());
  root.addEventListener('pointerdown', e => {
    if (!(e.button === 2 || (e.button === 0 && e.shiftKey))) return;
    const name = cellAt(e.clientX, e.clientY);
    e.preventDefault();
    e.stopImmediatePropagation();   // not a move as well
    if (!name) return;
    selected = null;
    drawing = { orig: name, dest: null, brush: brushFor(e), id: e.pointerId };
    root.setPointerCapture?.(e.pointerId);
    draw();
  });
  root.addEventListener('pointermove', e => {
    if (!drawing || e.pointerId !== drawing.id) return;
    const to = cellAt(e.clientX, e.clientY);
    const dest = to && to !== drawing.orig ? to : null;
    if (dest !== drawing.dest) { drawing.dest = dest; drawShapes(); }
  });
  const endDrawing = e => {
    if (!drawing || e.pointerId !== drawing.id) return false;
    const d = drawing;
    drawing = null;
    if (e.type === 'pointerup') toggleShape({ orig: d.orig, dest: d.dest || undefined, brush: d.brush });
    drawShapes();
    return true;
  };
  root.addEventListener('pointerup', endDrawing);
  root.addEventListener('pointercancel', endDrawing);

  root.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (shapes.length) { shapes = []; drawShapes(); }   // a plain click clears the drawing (chessground's eraseOnClick)
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
    // The page's own shapes (see the top), drawn under the user's
    setAutoShapes(list) { autoShapes = list || []; drawShapes(); },
    get shapes() { return shapes.map(s => ({ ...s })); },
    clearShapes() { shapes = []; drawShapes(); },
  };
}
