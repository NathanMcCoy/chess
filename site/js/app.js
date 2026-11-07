// The game: chess.js knows the rules, chessground draws the board, Stockfish (engine.js) plays the
// other side. The game is saved in this browser after every move, so a reload carries on.
import { Chess } from '../vendor/chess.js';
import { Chessground } from '../vendor/chessground.js';
import { Engine, LEVELS } from './engine.js';

const $ = id => document.getElementById(id);
const SAVE = 'chess.game.v1';
const COLOR = { w: 'white', b: 'black' };
const SYMBOL = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' };
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const MIN_THINK_MS = 350;   // even an instant reply waits this long, so you see your own move land

let game = new Chess();     // the game as played so far
let player = 'w';           // the side you play
let level = 3;              // 1 to 10
let result = null;          // { score: '1-0' | '0-1' | '1/2-1/2', text } once the game is over
let view = null;            // how many moves are shown while looking back; null = the latest
let orientation = 'white';
let busy = false;           // Stockfish is thinking
let request = 0;            // numbers each request, so an answer that arrives too late is ignored
let engineError = null;
let cardClosed = false;     // the result card was closed with "View the board" (it comes back on reload)

// --- Saving in this browser ------------------------------------------------------------------
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE) || 'null');
    if (!saved || typeof saved.pgn !== 'string') return false;
    const g = new Chess();
    g.loadPgn(saved.pgn);
    game = g;
    player = saved.player === 'b' ? 'b' : 'w';
    level = Math.min(10, Math.max(1, Number(saved.level) || 3));
    orientation = saved.orientation === 'black' ? 'black' : saved.orientation === 'white' ? 'white' : COLOR[player];
    result = saved.result && saved.result.score ? saved.result : null;
    return true;
  } catch {
    return false;   // nothing saved, or it can't be read: start a fresh game
  }
}

function save() {
  try {
    localStorage.setItem(SAVE, JSON.stringify({ pgn: game.pgn(), player, level, orientation, result }));
  } catch { /* private browsing or storage full: the game still works, it just won't survive a reload */ }
}

// --- The board -------------------------------------------------------------------------------
const board = Chessground($('board'), {
  orientation,
  coordinates: true,
  animation: { enabled: true, duration: 180 },
  highlight: { lastMove: true, check: true },
  movable: { free: false, showDests: true, events: { after: (from, to) => onBoardMove(from, to) } },
  premovable: { enabled: false },
  draggable: { enabled: true, showGhost: true },
  drawable: { enabled: true, visible: true, eraseOnClick: true },
});

const startFen = () => game.getHeaders().FEN || new Chess().fen();
const legalMoves = pos => {
  const dests = new Map();
  for (const m of pos.moves({ verbose: true })) dests.set(m.from, [...(dests.get(m.from) || []), m.to]);
  return dests;
};

function render() {
  const moves = game.history({ verbose: true });
  const shown = view === null ? moves.length : view;
  const live = shown === moves.length;
  const fen = shown === 0 ? startFen() : moves[shown - 1].after;
  const pos = live ? game : new Chess(fen);
  const last = moves[shown - 1];
  const yourTurn = live && !result && !busy && game.turn() === player;
  board.set({
    fen,
    orientation,
    turnColor: COLOR[pos.turn()],
    lastMove: last ? [last.from, last.to] : undefined,
    check: pos.inCheck(),
    movable: { color: yourTurn ? COLOR[player] : undefined, dests: yourTurn ? legalMoves(pos) : new Map() },
  });
  renderMoves(moves, shown);
  renderStatus(live, shown);
  renderCard(live);
  renderPlayers(pos);
  $('first').disabled = $('prev').disabled = shown === 0;
  $('next').disabled = $('last').disabled = live;
  $('undo').disabled = !moves.some(m => m.color === player);
  $('resign').disabled = !!result || moves.length === 0;
  $('download').disabled = moves.length === 0;
}

function renderMoves(moves, shown) {
  const list = $('moves');
  list.replaceChildren();
  let number = Number(startFen().split(' ')[5]) || 1;
  let row = null;
  moves.forEach((m, i) => {
    if (m.color === 'w' || !row) {
      row = document.createElement('li');
      const no = document.createElement('span');
      no.className = 'no';
      no.textContent = `${number}.`;
      row.append(no);
      if (m.color === 'b') row.append(document.createElement('span'));   // a game that starts with Black
      list.append(row);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = m.san;
    b.dataset.ply = String(i + 1);
    if (i + 1 === shown) b.classList.add('current');
    row.append(b);
    if (m.color === 'b') { number++; row = null; }
  });
  if (result) {
    const end = document.createElement('li');
    end.className = 'result';
    end.textContent = result.score.replace('1/2', '½');
    list.append(end);
  }
  // Keep the current move visible by scrolling the list itself. (scrollIntoView would scroll the
  // whole page on a phone, pushing the board off the screen after every move.)
  const current = list.querySelector('.current');
  if (current) {
    const top = current.offsetTop - list.offsetTop, bottom = top + current.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  } else if (view === null) list.scrollTop = list.scrollHeight;
}

function renderStatus(live, shown) {
  const status = $('status');
  status.classList.toggle('over', !!result && live);
  if (engineError) status.textContent = `Stockfish couldn't start: ${engineError}`;
  else if (!live) status.textContent = `Looking at move ${Math.ceil(shown / 2) || 'start'}. Press ⏭ to go back to the game.`;
  else if (result) status.textContent = result.text;
  else if (busy) status.textContent = 'Stockfish is thinking…';
  else status.textContent = game.inCheck() ? 'Check! Your move.' : 'Your move.';
}

function renderPlayers(pos) {
  const name = side => side === player ? 'You' : `Stockfish · level ${level}, ${LEVELS[level - 1].name}`;
  // What each side has captured, from the moves themselves (counting what's missing from the
  // board would also count a pawn that promoted), and who's ahead on material on the board now
  const shown = view === null ? Infinity : view;
  const captured = { w: [], b: [] };
  game.history({ verbose: true }).slice(0, shown).forEach(m => { if (m.captured) captured[m.color].push(m.captured); });
  const onBoard = { w: 0, b: 0 };
  for (const row of pos.board()) for (const sq of row) if (sq && sq.type !== 'k') onBoard[sq.color] += VALUE[sq.type];
  const taken = side => {
    const other = side === 'w' ? 'b' : 'w';
    // ︎ asks for the plain-text form of each symbol, not an emoji
    const pieces = captured[side].sort((a, b) => VALUE[a] - VALUE[b]).map(t => SYMBOL[t] + '︎').join('');
    const ahead = onBoard[side] - onBoard[other];
    return pieces + (ahead > 0 ? ` +${ahead}` : '');
  };
  const bottom = orientation === 'white' ? 'w' : 'b';
  const top = bottom === 'w' ? 'b' : 'w';
  for (const [id, side] of [['bottom-player', bottom], ['top-player', top]]) {
    $(id).querySelector('.name').textContent = name(side);
    $(id).querySelector('.taken').textContent = taken(side);
  }
}

// --- Playing ---------------------------------------------------------------------------------
async function onBoardMove(from, to) {
  const piece = game.get(from);
  let promotion;
  if (piece && piece.type === 'p' && (to[1] === '8' || to[1] === '1')) {
    promotion = await choosePromotion();
    if (!promotion) return render();   // changed their mind: put the pawn back
  }
  try {
    game.move({ from, to, promotion });
  } catch {
    return render();
  }
  view = null;
  afterMove();
}

function afterMove() {
  checkEnd();
  save();
  render();
  if (!result && game.turn() !== player) engineMove();
}

async function engineMove() {
  const mine = ++request;
  busy = true;
  render();
  const settings = LEVELS[level - 1];
  const started = Date.now();
  let uci = null;
  if (settings.random && Math.random() < settings.random) {
    const legal = game.moves({ verbose: true });
    const m = legal[Math.floor(Math.random() * legal.length)];
    uci = m && m.from + m.to + (m.promotion || '');
  } else {
    uci = await engine.bestMove(game.fen(), settings);
  }
  const wait = MIN_THINK_MS - (Date.now() - started);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  if (mine !== request) return;   // taken back, or a new game started, while it thought
  busy = false;
  if (!uci) return render();
  game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  afterMove();
}

// A finished game: the score, who won ('w', 'b' or null for a draw), how, and a sentence for the
// status line. Setting it also reopens the result card.
function finish(winner, reason, text) {
  result = { score: winner === 'w' ? '1-0' : winner === 'b' ? '0-1' : '1/2-1/2', winner, reason, text };
  game.setHeader('Result', result.score);
  cardClosed = false;
}

function checkEnd() {
  if (result) return;
  if (game.isCheckmate()) {
    const winner = game.turn() === 'w' ? 'b' : 'w';
    finish(winner, 'checkmate', winner === player ? 'Checkmate. You win!' : 'Checkmate. Stockfish wins.');
  } else if (game.isStalemate()) finish(null, 'stalemate', 'Stalemate: a draw.');
  else if (game.isInsufficientMaterial()) finish(null, 'material', 'A draw: neither side has enough pieces left to checkmate.');
  else if (game.isThreefoldRepetition()) finish(null, 'repetition', 'A draw by repetition: the same position came up three times.');
  else if (game.isDrawByFiftyMoves()) finish(null, 'fifty', 'A draw by the fifty-move rule.');
}

// The card over the board: shown while you're at the end of a finished game, until you close it
const REASONS = {
  checkmate: 'By checkmate.', resign: 'You resigned.', stalemate: 'Stalemate: no legal moves, but no check.',
  material: 'Neither side can checkmate any more.', repetition: 'The same position came up three times.',
  fifty: 'Fifty moves with no capture or pawn move.',
};
function renderCard(live) {
  const box = $('gameover');
  box.hidden = !(result && live && !cardClosed);
  if (box.hidden) return;
  const card = box.querySelector('.go-card');
  const outcome = !result.winner ? 'draw' : result.winner === player ? 'win' : 'loss';
  card.className = `go-card ${outcome}`;
  $('go-title').textContent = outcome === 'win' ? 'You win!' : outcome === 'loss' ? 'Stockfish wins' : 'Draw';
  $('go-score').textContent = result.score.replace(/1\/2/g, '½');
  const moves = Math.ceil(game.history().length / 2);
  const how = REASONS[result.reason] || result.text;   // games saved before reasons existed
  $('go-reason').textContent = `${how} Level ${level}, ${moves} move${moves === 1 ? '' : 's'}.`;
}

function stopEngine() {
  request++;
  if (busy) engine.stop();
  busy = false;
}

function takeBack() {
  stopEngine();
  if (result) { result = null; game.setHeader('Result', '*'); }   // taking back reopens a finished game
  while (game.history().length) {
    if (game.undo().color === player) break;   // back to before your last move
  }
  view = null;
  save();
  render();
  if (game.turn() !== player) engineMove();   // e.g. playing Black with none of your moves left
}

function newGame(side, newLevel) {
  stopEngine();
  engine.newGame();
  game = new Chess();
  player = side;
  level = newLevel;
  result = null;
  view = null;
  orientation = COLOR[side];
  const now = new Date();
  const date = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
  const bot = `Stockfish level ${newLevel}`;
  for (const [k, v] of [['Event', 'Casual game'], ['Site', 'chess.pacificfish.ca'], ['Date', date],
    ['White', side === 'w' ? 'You' : bot], ['Black', side === 'b' ? 'You' : bot], ['Result', '*']]) game.setHeader(k, v);
  save();
  render();
  if (player === 'b') engineMove();
}

// --- Boxes -----------------------------------------------------------------------------------
function choosePromotion() {
  const box = $('promotion');
  for (const p of box.querySelectorAll('piece')) p.className = `${p.className.split(' ')[0]} ${COLOR[player]}`;
  return new Promise(resolve => {
    const pick = e => {
      const b = e.target.closest('button[data-piece]');
      if (!b) return;
      done(b.dataset.piece);
    };
    const done = piece => {
      box.removeEventListener('click', pick);
      box.removeEventListener('cancel', cancel);
      box.close();
      resolve(piece);
    };
    const cancel = e => { e.preventDefault(); done(null); };
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

function openNewGame() {
  const box = $('new-dialog');
  const slider = $('level');
  slider.value = String(level);
  box.querySelector(`input[name=side][value="${player}"]`).checked = true;
  const showLevel = () => { $('level-name').textContent = `${slider.value}: ${LEVELS[slider.value - 1].name}`; };
  showLevel();
  slider.oninput = showLevel;
  box.returnValue = '';
  box.addEventListener('close', () => {
    if (box.returnValue !== 'start') return;
    let side = box.querySelector('input[name=side]:checked').value;
    if (side === 'random') side = Math.random() < 0.5 ? 'w' : 'b';
    newGame(side, Number(slider.value));
  }, { once: true });
  box.showModal();
}

function downloadPgn() {
  const blob = new Blob([game.pgn() + '\n'], { type: 'application/x-chess-pgn' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chess-${(game.getHeaders().Date || 'game').replace(/\./g, '-')}.pgn`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- Looking back through the game -----------------------------------------------------------
function show(ply) {
  const total = game.history().length;
  view = ply >= total ? null : Math.max(0, ply);
  render();
}
const shownPly = () => (view === null ? game.history().length : view);

$('first').onclick = () => show(0);
$('prev').onclick = () => show(shownPly() - 1);
$('next').onclick = () => show(shownPly() + 1);
$('last').onclick = () => show(Infinity);
$('moves').onclick = e => { const b = e.target.closest('button[data-ply]'); if (b) show(Number(b.dataset.ply)); };
document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]') || e.target.closest('input, textarea, select')) return;
  const keys = { ArrowLeft: () => show(shownPly() - 1), ArrowRight: () => show(shownPly() + 1), Home: () => show(0), End: () => show(Infinity) };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

$('new-game').onclick = openNewGame;
$('go-rematch').onclick = () => newGame(player, level);
$('go-new').onclick = openNewGame;
$('go-close').onclick = () => { cardClosed = true; render(); };
$('undo').onclick = takeBack;
$('flip').onclick = () => { orientation = orientation === 'white' ? 'black' : 'white'; save(); render(); };
$('download').onclick = downloadPgn;
$('resign').onclick = async () => {
  if (!(await confirmBox('Resign this game? Stockfish will be given the win.', 'Resign'))) return;
  stopEngine();
  finish(player === 'w' ? 'b' : 'w', 'resign', 'You resigned. Stockfish wins.');
  view = null;
  save();
  render();
};

// --- Start -----------------------------------------------------------------------------------
const engine = new Engine();
engine.worker.addEventListener('error', e => { engineError = e.message || 'unknown error'; busy = false; render(); });
if (load()) {
  render();
  if (!result && game.turn() !== player) engineMove();   // it was Stockfish's turn when the page closed
} else {
  newGame('w', 3);
}
