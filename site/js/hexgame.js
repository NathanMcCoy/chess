// The hexagonal chess page (/hex): Gliński's rules (variants/hex.js) on the hex board
// (boards/hexboard.js), for two players on one device. The game is kept in this browser.
import hex from './variants/hex.js';
import { hexBoard } from './boards/hexboard.js';

const SAVE = 'chess.hex.v1';
const NAME = { w: 'White', b: 'Black' };
const other = c => (c === 'w' ? 'b' : 'w');
const $ = id => document.getElementById(id);
const MOVE = /^([a-l]\d{1,2})([a-l]\d{1,2})([qrbn]?)$/;

let game = { start: hex.start(), moves: [] };
let played = null;          // hex.replay of the game: states, names, result
let viewing = null;         // the move number being looked at, or null for the latest position
let orientation = 'w';      // who's at the bottom
let autoTurn = false;       // turn the board to whoever's move it is
let cardClosed = false;     // the result card was put away to look at the board

// --- Kept in this browser ----------------------------------------------------------------------
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE) || 'null');
    if (!s || s.variant !== 'hex' || typeof s.start !== 'string' || !Array.isArray(s.moves)) return;
    if (hex.replay(s.start, s.moves).error) return;   // damaged: start afresh
    game = { start: s.start, moves: s.moves };
    orientation = s.orientation === 'b' ? 'b' : 'w';
    autoTurn = s.autoTurn === true;
    cardClosed = s.cardClosed === true;
  } catch { /* storage blocked or the save isn't JSON: a new game */ }
}
function save() {
  try { localStorage.setItem(SAVE, JSON.stringify({ variant: 'hex', start: game.start, moves: game.moves, orientation, autoTurn, cardClosed })); } catch { /* storage blocked */ }
}

// --- The result ---------------------------------------------------------------------------------
const frac = p => ({ 0: '0', 0.25: '¼', 0.5: '½', 0.75: '¾', 1: '1' })[p] ?? String(p);
function describe(r) {
  const points = r.points || (r.winner ? { [r.winner]: 1, [other(r.winner)]: 0 } : { w: 0.5, b: 0.5 });
  const score = `${frac(points.w)}–${frac(points.b)}`;
  const texts = {
    checkmate: () => [`${NAME[r.winner]} wins`, 'Checkmate.'],
    stalemate: () => {
      const giver = points.w > points.b ? 'w' : 'b';
      return [`${NAME[giver]} scores ¾`, `Stalemate: ${NAME[other(giver)]} can’t move. In Gliński’s chess that scores ¾ to the side that gave it and ¼ to the other.`];
    },
    material: () => ['Draw', 'Neither side has enough pieces left to checkmate.'],
    repetition: () => ['Draw', 'A draw by repetition: the same position came up three times.'],
    fifty: () => ['Draw', 'A draw by the fifty-move rule.'],
  };
  const [title, text] = (texts[r.reason] || (() => ['Game over', '']))();
  return { score, title, text, outcome: r.winner ? 'win' : 'draw' };
}

// --- Drawing it all -----------------------------------------------------------------------------
const board = hexBoard($('hexboard'), { geometry: hex.geometry, onMove: (from, to) => play(from, to) });

function render() {
  played = hex.replay(game.start, game.moves);
  const n = game.moves.length;
  const at = viewing ?? n;
  const state = played.states[at];
  const live = at === n && !played.result;
  const turn = hex.turn(state);
  const pieces = hex.pieces(state);

  const dests = {};
  if (live) for (const m of hex.legal(state)) {
    const [, from, to] = m.match(MOVE);
    (dests[from] ||= []).includes(to) || dests[from].push(to);
  }
  const last = at > 0 ? game.moves[at - 1].match(MOVE) : null;
  const check = hex.inCheck(state) ? Object.keys(pieces).find(c => pieces[c] === (turn === 'w' ? 'K' : 'k')) : null;
  board.set({ pieces, dests, lastMove: last ? [last[1], last[2]] : null, check, orientation });

  // Status, and the players either side of the board
  const status = $('status');
  status.classList.toggle('over', !!played.result && at === n);
  if (at < n) status.textContent = at === 0 ? 'Looking at the start. → to go on.' : `Looking at move ${Math.ceil(at / 2)}${at % 2 ? '' : '…'} ${played.names[at - 1]}.`;
  else if (played.result) status.textContent = `${describe(played.result).title}. ${describe(played.result).text}`;
  else status.textContent = `${NAME[turn]} to move${check ? ': in check!' : '.'}`;
  for (const [id, side] of [['top-player', other(orientation)], ['bottom-player', orientation]]) {
    const row = $(id);
    row.querySelector('.name').textContent = NAME[side];
    row.classList.toggle('to-move', live && turn === side);
  }

  // The moves, two to a row, each one a button to look at that position
  const list = $('moves');
  list.replaceChildren();
  for (let i = 0; i < n; i += 2) {
    const li = document.createElement('li');
    const no = document.createElement('span');
    no.className = 'no';
    no.textContent = `${i / 2 + 1}.`;
    li.append(no);
    for (const j of [i, i + 1]) {
      if (j >= n) break;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = played.names[j];
      b.classList.toggle('current', j === at - 1);
      b.onclick = () => show(j + 1);
      li.append(b);
    }
    list.append(li);
  }
  if (played.result) {
    const li = document.createElement('li');
    li.className = 'result';
    li.textContent = describe(played.result).score;
    list.append(li);
  }
  list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });

  $('first').disabled = $('prev').disabled = at === 0;
  $('next').disabled = $('last').disabled = at === n;
  $('undo').disabled = n === 0;
  $('auto-turn').checked = autoTurn;

  // The result card, over the board, until it's put away
  const box = $('gameover');
  box.hidden = !(played.result && at === n && !cardClosed);
  if (!box.hidden) {
    const d = describe(played.result);
    box.querySelector('.go-card').className = `go-card ${d.outcome}`;
    $('go-score').textContent = d.score;
    $('go-title').textContent = d.title;
    $('go-reason').textContent = d.text;
  }
  save();
}

const show = at => { viewing = Math.max(0, Math.min(at, game.moves.length)); if (viewing === game.moves.length) viewing = null; render(); };

async function play(from, to) {
  const state = played.states.at(-1);
  const options = hex.legal(state).filter(m => { const [, f, t] = m.match(MOVE); return f === from && t === to; });
  if (!options.length) return render();
  let move = options[0];
  if (options.length > 1) {   // a promotion: which piece?
    const piece = await choosePromotion(hex.turn(state));
    if (!piece) return render();
    move = from + to + piece;
  }
  game.moves = [...game.moves, move];
  viewing = null;
  cardClosed = false;
  if (autoTurn) orientation = hex.turn(hex.replay(game.start, game.moves).states.at(-1));
  render();
}

// --- Boxes --------------------------------------------------------------------------------------
function choosePromotion(side) {
  const box = $('promotion');
  for (const p of box.querySelectorAll('piece')) p.className = `${p.className.split(' ')[0]} ${side === 'w' ? 'white' : 'black'}`;
  return new Promise(resolve => {
    const pick = e => { const b = e.target.closest('button[data-piece]'); if (b) done(b.dataset.piece); };
    const cancel = e => { e.preventDefault(); done(null); };
    const done = piece => {
      box.removeEventListener('click', pick);
      box.removeEventListener('cancel', cancel);
      box.close();
      resolve(piece);
    };
    box.addEventListener('click', pick);
    box.addEventListener('cancel', cancel);
    box.showModal();
  });
}

function confirmBox(text, yes) {
  const box = $('confirm');
  $('confirm-text').textContent = text;
  $('confirm-yes').textContent = yes;
  box.returnValue = '';
  return new Promise(resolve => {
    box.addEventListener('close', () => resolve(box.returnValue === 'yes'), { once: true });
    box.showModal();
  });
}

async function newGame() {
  if (game.moves.length && !played.result && !(await confirmBox('Start a new game? This one will be lost.', 'New game'))) return;
  game = { start: hex.start(), moves: [] };
  viewing = null;
  cardClosed = false;
  if (autoTurn) orientation = 'w';
  render();
}

// --- Buttons and keys ---------------------------------------------------------------------------
$('new-game').onclick = newGame;
$('go-new').onclick = newGame;
$('go-close').onclick = () => { cardClosed = true; render(); };
$('undo').onclick = () => {
  game.moves = game.moves.slice(0, -1);
  viewing = null;
  cardClosed = false;
  if (autoTurn) orientation = hex.turn(hex.replay(game.start, game.moves).states.at(-1));
  render();
};
$('flip').onclick = () => { orientation = other(orientation); render(); };
$('auto-turn').onchange = e => {
  autoTurn = e.target.checked;
  if (autoTurn) orientation = hex.turn(played.states.at(-1));
  render();
};
$('first').onclick = () => show(0);
$('prev').onclick = () => show((viewing ?? game.moves.length) - 1);
$('next').onclick = () => show((viewing ?? game.moves.length) + 1);
$('last').onclick = () => show(Infinity);
document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]') || e.target.closest('input, textarea, select, summary')) return;
  const at = viewing ?? game.moves.length;
  const keys = { ArrowLeft: () => show(at - 1), ArrowRight: () => show(at + 1), Home: () => show(0), End: () => show(Infinity) };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

load();
render();
