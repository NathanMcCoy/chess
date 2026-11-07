// The game: chess.js knows the rules, chessground draws the board, Stockfish (engine.js) plays the
// other side. The game is saved in this browser after every move, so a reload carries on.
import { Chess } from '../vendor/chess.js';
import { Chessground } from '../vendor/chessground.js';
import { Engine, LEVELS } from './engine.js';
import { RATING, RATINGS, rate, accuracy, whiteChance, evalText } from './review.js';
import { initAccounts } from './account.js';
import { getGame, joinGame, act, follow, clockText, timeText, askForGame, createGame, openLobby } from './online.js';

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
let review = null;          // { key, positions: [{ score, best, turn, legal }] }: the finished game analysed, saved with it
let reviewing = false;      // the review is on screen
let analysing = 0;          // numbers each analysis run, so leaving the review stops it
let analyst = null;         // a second, full-strength Stockfish just for the review, started when first needed
let reviewError = null;
let liner = null;           // a third Stockfish for the top lines of the position on the board, started when first needed
let lineRequest = 0;        // numbers each request, so lines that arrive for a position you've left are ignored
let lineState = { fen: null, lines: [], depth: 0 };
let accounts = null;        // signing in, and keeping your game in your account (account.js)
let online = null;          // a game against a person, while one is open: { id, you, view, at, stop, problem }

// --- Saving in this browser (and, when signed in, in your account: account.js) ----------------
function load() {
  try {
    return loadFrom(JSON.parse(localStorage.getItem(SAVE) || 'null'));
  } catch {
    return false;   // nothing saved, or it can't be read: start a fresh game
  }
}

// A saved game (from this browser or from your account) into play. False if it isn't one.
function loadFrom(saved) {
  try {
    if (!saved || typeof saved.pgn !== 'string' || (saved.variant && saved.variant !== 'chess')) return false;
    const g = new Chess();
    g.loadPgn(saved.pgn);
    game = g;
    player = saved.player === 'b' ? 'b' : 'w';
    level = Math.min(10, Math.max(1, Number(saved.level) || 3));
    orientation = saved.orientation === 'black' ? 'black' : saved.orientation === 'white' ? 'white' : COLOR[player];
    result = saved.result && saved.result.score ? saved.result : null;
    // Games saved before results recorded a winner: work it out from the score
    if (result && !('winner' in result)) result.winner = { '1-0': 'w', '0-1': 'b' }[result.score] || null;
    // An analysis is kept only if it is of this very game
    review = saved.review && saved.review.key === gameKey() && Array.isArray(saved.review.positions) ? saved.review : null;
    return true;
  } catch {
    return false;
  }
}

// The game as it's saved. `variant` says which rules it's played by (saves from before it existed
// are chess); the hexagonal variant will save its own kind.
const saved = () => ({ variant: 'chess', pgn: game.pgn(), player, level, orientation, result, review });

function save() {
  if (online) return;   // a game against a person is kept by the server; your Stockfish game stays as it was
  try {
    localStorage.setItem(SAVE, JSON.stringify(saved()));
  } catch { /* private browsing or storage full: the game still works, it just won't survive a reload */ }
  accounts?.saved();   // and to your account, if you're signed in
}

// Your account's copy of the game, replacing the one in play (signing in on another device)
function useSaved(data) {
  // In a game against a person: keep your account's Stockfish game for later, don't switch to it
  if (online) { try { localStorage.setItem(SAVE, JSON.stringify(data)); } catch { /* as above */ } return true; }
  stopEngine();
  dropReview();
  if (!loadFrom(data)) return false;
  view = null;
  cardClosed = false;
  try { localStorage.setItem(SAVE, JSON.stringify(saved())); } catch { /* as above */ }
  render();
  if (!result && game.turn() !== player) engineMove();
  return true;
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
const gameKey = () => `${startFen()}|${game.history().join(' ')}`;
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
  const mine = online ? online.you : player;   // watching a game: nobody's moves are yours
  const yourTurn = live && !result && !busy && !engineError && !!mine && game.turn() === mine && (!online || online.view.status === 'playing');
  board.set({
    fen,
    orientation,
    turnColor: COLOR[pos.turn()],
    lastMove: last ? [last.from, last.to] : undefined,
    check: pos.inCheck(),
    movable: { color: yourTurn ? COLOR[mine] : undefined, dests: yourTurn ? legalMoves(pos) : new Map() },
  });
  renderMoves(moves, shown);
  renderStatus(live, shown);
  renderCard(live);
  renderPlayers(pos);
  renderReview(moves, shown);
  $('first').disabled = $('prev').disabled = shown === 0;
  $('next').disabled = $('last').disabled = live;
  $('undo').disabled = !moves.some(m => m.color === player);
  $('resign').disabled = online ? !(online.you && online.view.status === 'playing') : !!result || moves.length === 0;
  $('download').disabled = moves.length === 0;
  $('review-game').hidden = !result || moves.length === 0;
  renderOnline();
  renderClocks();
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
    const r = ratingOf(i, moves);
    if (r) {
      b.dataset.rating = r.rating;
      b.title = RATING[r.rating].label;
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = RATING[r.rating].badge;
      badge.setAttribute('aria-label', RATING[r.rating].label);
      b.prepend(badge);
    }
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
  status.classList.toggle('broken', !!engineError);
  if (notice && !online) status.textContent = notice;
  else if (engineError && !online) status.textContent = `Stockfish isn’t working: ${engineError}. Reload the page to try again.`;
  else if (reviewing) status.textContent = result ? result.text : 'Game review';
  else if (!live) status.textContent = `Looking at move ${Math.ceil(shown / 2) || 'start'}. Press ⏭ to go back to the game.`;
  else if (online) status.textContent = onlineStatus();
  else if (result) status.textContent = result.text;
  else if (busy) status.textContent = 'Stockfish is thinking…';
  else status.textContent = game.inCheck() ? 'Check! Your move.' : 'Your move.';
}

function renderPlayers(pos) {
  const name = side => sideName(side);
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
  notice = null;
  if (online) { online.problem = null; render(); return sendMove(from + to + (promotion || '')); }
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
    try {
      uci = await engine.bestMove(game.fen(), settings);
    } catch (e) {
      if (mine === request) engineBroke(e);
      return;
    }
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
  box.hidden = !(result && live && !cardClosed && !reviewing);
  if (box.hidden) return;
  const card = box.querySelector('.go-card');
  const you = online ? online.you : player;
  const outcome = !result.winner ? 'draw' : !you ? 'draw' : result.winner === you ? 'win' : 'loss';
  card.className = `go-card ${outcome}`;
  $('go-title').textContent = online
    ? (result.reason === 'aborted' ? 'Called off' : !result.winner ? 'Draw' : !you ? `${COLOR_NAME[result.winner]} wins` : outcome === 'win' ? 'You win!' : `${Them()} wins`)
    : outcome === 'win' ? 'You win!' : outcome === 'loss' ? 'Stockfish wins' : 'Draw';
  $('go-rematch').hidden = !!online;
  $('go-score').textContent = result.score.replace(/1\/2/g, '½');
  const moves = Math.ceil(game.history().length / 2);
  const how = REASONS[result.reason] || result.text;   // games saved before reasons existed
  const length = `${moves} move${moves === 1 ? '' : 's'}`;
  $('go-reason').textContent = online
    ? `${result.text} ${timeText(online.view.times.w)} against ${timeText(online.view.times.b)}, ${length}.`
    : `${how} Level ${level}, ${length}.`;
}

// Stockfish has stopped working: say so, and stop the game where it is (you can still look back
// through it, download it or start over after a reload)
function engineBroke(e) {
  engineError = e.message || String(e);
  busy = false;
  render();
}

function stopEngine() {
  request++;
  if (busy) engine.stop();
  busy = false;
}

function takeBack() {
  stopEngine();
  if (result) { result = null; game.setHeader('Result', '*'); }   // taking back reopens a finished game
  dropReview();
  while (game.history().length) {
    if (game.undo().color === player) break;   // back to before your last move
  }
  view = null;
  save();
  render();
  if (game.turn() !== player) engineMove();   // e.g. playing Black with none of your moves left
}

function newGame(side, newLevel) {
  if (online) { leaveOnline(); if (location.search) history.pushState(null, '', location.pathname); }
  notice = null;
  stopEngine();
  engine.newGame();
  game = new Chess();
  player = side;
  level = newLevel;
  result = null;
  dropReview();
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

// --- The game review -------------------------------------------------------------------------
// Every position of the finished game is analysed at full strength (one at a time, saving as it
// goes, so a reload carries on where it stopped), and each move is rated by how much of the mover's
// winning chances it gave away (review.js).
async function startReview() {
  if (!result || !game.history().length) return;
  reviewing = true;
  cardClosed = true;
  reviewError = null;
  if (view === null) view = 0;   // start from the beginning, like reading the game through
  if (!review) review = { key: gameKey(), positions: [] };
  render();
  const mine = ++analysing;
  analyst ||= new Engine();
  const fens = [startFen(), ...game.history({ verbose: true }).map(m => m.after)];
  for (let i = review.positions.length; i < fens.length; i++) {
    const pos = new Chess(fens[i]);
    let found;
    if (pos.isCheckmate()) found = { score: { mate: 0 }, best: null };   // the side to move is mated
    else if (pos.isStalemate() || pos.isInsufficientMaterial()) found = { score: { cp: 0 }, best: null };
    else {
      try {
        found = await analyst.analyse(fens[i]);
      } catch (e) {
        if (mine === analysing) { reviewError = e.message || String(e); render(); }
        return;
      }
    }
    if (mine !== analysing) return;   // the review was left, or the game changed, meanwhile
    review.positions.push({ ...found, turn: pos.turn(), legal: pos.moves().length });
    save();
    render();
  }
}

// The top three lines for a position: asked for when the position on the board changes, shown
// as Stockfish searches deeper. The search for the position before is stopped first.
function wantLines(fen) {
  if (lineState.fen === fen) return;
  const mine = ++lineRequest;
  lineState = { fen, lines: [], depth: 0 };
  if (new Chess(fen).isGameOver()) { lineState.over = true; return; }
  liner ||= new Engine();
  liner.stop();
  const still = () => mine === lineRequest;
  liner.lines(fen, {}, (lines, depth) => { if (still()) { lineState = { fen, lines, depth }; renderLines(); } })
    .then(lines => { if (still() && lines.length) { lineState = { ...lineState, lines, done: true }; renderLines(); } })
    .catch(e => { if (still()) { lineState = { ...lineState, error: e.message || String(e) }; renderLines(); } });
}

function stopLines() {
  lineRequest++;
  lineState = { fen: null, lines: [], depth: 0 };
  if (liner) liner.stop();
}

// A line of moves as people write them: "12. Nf3 Nc6 13. Bb5", or "12… Nc6 13. Bb5" from Black
function lineText(fen, pv, plies = 9) {
  const pos = new Chess(fen);
  let number = Number(fen.split(' ')[5]) || 1;
  const out = [];
  for (const uci of pv.slice(0, plies)) {
    const turn = pos.turn();
    let m;
    try { m = pos.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { break; }
    if (turn === 'w') out.push(`${number}.`);
    else if (!out.length) out.push(`${number}…`);
    out.push(m.san);
    if (turn === 'b') number++;
  }
  return out.join(' ') + (pv.length > plies ? ' …' : '');
}

function renderLines() {
  const box = $('rv-lines');
  box.replaceChildren();
  const head = document.createElement('p');
  head.className = 'rv-lines-head';
  const { fen, lines, depth, over, error } = lineState;
  if (!fen) return;
  if (error) head.textContent = `Stockfish isn’t working: ${error}.`;
  else if (over) head.textContent = 'No moves to suggest: the game is over here.';
  else head.textContent = depth ? `Top lines · depth ${depth}` : 'Top lines · thinking…';
  box.append(head);
  const turn = fen.split(' ')[1];
  for (const line of lines) {
    const row = document.createElement('p');
    row.className = 'rv-line';
    const score = document.createElement('span');
    const text = evalText(line.score, turn);
    score.className = `rv-score ${/^−/.test(text) ? 'black' : 'white'}`;
    score.textContent = text;
    const moves = document.createElement('span');
    moves.className = 'rv-pv';
    moves.textContent = lineText(fen, line.pv);
    row.append(score, moves);
    box.append(row);
  }
}

function leaveReview() {
  stopLines();
  analysing++;
  if (analyst) analyst.stop();
  reviewing = false;
  view = null;
  render();
}

function dropReview() {
  stopLines();
  analysing++;
  if (analyst) analyst.stop();
  review = null;
  reviewing = false;
}

// Move i's rating (0 = the first move), once the positions either side of it are analysed
function ratingOf(i, moves) {
  const p = review && review.positions;
  if (!p || !p[i + 1]) return null;
  const m = (moves || game.history({ verbose: true }))[i];
  return rate(p[i], p[i + 1], m.from + m.to + (m.promotion || ''), p[i].legal);
}

// A move in UCI form ("g1f3") as people write it ("Nf3"), in the position it's played from
function san(fen, uci) {
  try { return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; } catch { return uci; }
}

function renderReview(moves, shown) {
  document.body.classList.toggle('reviewing', reviewing);
  $('review').hidden = !reviewing;
  $('evalbar').hidden = !reviewing;
  $('rv-summary').hidden = !reviewing;
  if (!reviewing) { board.setAutoShapes([]); return; }
  const positions = review ? review.positions : [];
  const total = moves.length + 1;
  const fullMoves = Math.ceil(moves.length / 2);

  // Progress while it works
  const progress = $('rv-progress');
  progress.hidden = positions.length >= total && !reviewError;
  progress.querySelector('span').textContent = reviewError
    ? `Stockfish isn’t working: ${reviewError}. Reload the page to try again.`
    : `Analysing move ${Math.min(Math.floor(positions.length / 2) + 1, fullMoves)} of ${fullMoves}…`;
  progress.querySelector('progress').value = positions.length / total;

  // The evaluation bar: White's chances in the position on the board
  const here = positions[shown];
  const bar = $('evalbar');
  const white = here ? whiteChance(here.score, here.turn) : 50;
  bar.classList.toggle('flipped', orientation === 'black');
  bar.classList.toggle('black-ahead', white < 50);
  bar.querySelector('.fill').style.height = `${white}%`;
  bar.querySelector('.score').textContent = here ? evalText(here.score, here.turn).replace(/^[+−]/, '') : '';

  // The verdict on the move just played, and an arrow for what Stockfish would have played
  const verdict = $('rv-verdict');
  const fens = [startFen(), ...moves.map(m => m.after)];
  if (lineState.fen !== fens[shown]) { wantLines(fens[shown]); renderLines(); }
  const r = shown > 0 ? ratingOf(shown - 1, moves) : null;
  const shapes = [];
  verdict.style.removeProperty('--rc');
  if (shown === 0) verdict.textContent = 'The starting position. Step through the moves with ▶ or the arrow keys.';
  else if (!r) verdict.textContent = `${moves[shown - 1].san}: still being analysed…`;
  else {
    const m = moves[shown - 1], before = positions[shown - 1], label = RATING[r.rating].label.toLowerCase();
    const who = possessive(m.color);
    verdict.replaceChildren();
    verdict.style.setProperty('--rc', `var(--r-${r.rating})`);
    const head = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = `${m.san}${RATING[r.rating].symbol}`;
    const what = r.forced ? ' was the only move.' : r.rating === 'best' ? ' was the best move.'
      : ` was ${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}.`;
    head.append(`${who} `, b, what);
    const line = document.createElement('span');
    line.className = 'best';
    const now = positions[shown];
    const evalNow = !now ? '' : now.score && now.score.mate === 0 ? 'Checkmate.' : `Evaluation ${evalText(now.score, now.turn)}.`;
    line.textContent = [r.rating !== 'best' && before.best ? `Best was ${san(fens[shown - 1], before.best)}.` : '', evalNow].filter(Boolean).join(' ');
    verdict.append(head, line);
    if (r.rating !== 'best' && before.best) shapes.push({ orig: before.best.slice(0, 2), dest: before.best.slice(2, 4), brush: 'green' });
    // The move's badge on the corner of the square it landed on (drawn by chessground in a
    // 100 × 100 box over the square; colours come from the stylesheet, as the security policy
    // allows no inline styles)
    shapes.push({ orig: m.to, customSvg: { html: `<g class="sq-badge" data-rating="${r.rating}"><circle cx="82" cy="18" r="17"/><text x="82" y="19">${RATING[r.rating].badge}</text></g>` } });
  }
  board.setAutoShapes(shapes);

  // The graph: White's chances move by move, with the poor moves marked and the current one lit
  const svg = $('rv-graph');
  const x = i => (moves.length ? (i / moves.length) * 100 : 0);
  const y = p => 32 - (p / 100) * 32;
  const points = positions.map((p, i) => `${x(i).toFixed(2)},${y(whiteChance(p.score, p.turn)).toFixed(2)}`);
  let marks = '';
  for (let i = 0; i < moves.length; i++) {
    const ri = ratingOf(i, moves);
    if (ri && ['inaccuracy', 'mistake', 'blunder'].includes(ri.rating)) {
      marks += `<line class="mark" data-rating="${ri.rating}" x1="${x(i + 1)}" x2="${x(i + 1)}" y1="0" y2="32"/>`;
    }
  }
  svg.innerHTML = '<line class="mid" x1="0" x2="100" y1="16" y2="16"/>'
    + (points.length > 1 ? `<polygon class="area" points="0,32 ${points.join(' ')} ${x(positions.length - 1).toFixed(2)},32"/>` : '')
    + marks + `<line class="now" x1="${x(shown)}" x2="${x(shown)}" y1="0" y2="32"/>`;

  // The summary: accuracy and how many moves of each rating, for each side
  const sides = ['w', 'b'].map(c => ({ c, name: sideName(c, true), losses: [], counts: {} }));
  for (let i = 0; i < moves.length; i++) {
    const ri = ratingOf(i, moves);
    if (!ri) continue;
    const side = sides.find(s => s.c === moves[i].color);
    side.losses.push(ri.loss);
    side.counts[ri.rating] = (side.counts[ri.rating] || 0) + 1;
  }
  const acc = s => { const a = accuracy(s.losses); return a === null ? '…' : a.toFixed(1); };
  const table = $('rv-summary');
  table.replaceChildren();
  const row = (cells, cls) => {
    const tr = document.createElement('tr');
    if (cls) tr.className = cls;
    for (const [text, rating, tag = 'td', klass] of cells) {
      const c = document.createElement(tag);
      c.textContent = text;
      if (rating) c.dataset.rating = rating;
      if (klass) c.className = klass;
      tr.append(c);
    }
    return tr;
  };
  const head = document.createElement('thead');
  head.append(row([['', null, 'th'], ...sides.map(s => [`${s.name} (${COLOR[s.c]})`, null, 'th'])]));
  const body = document.createElement('tbody');
  body.append(row([['Accuracy'], ...sides.map(s => [acc(s)])], 'acc'));
  for (const rt of RATINGS) body.append(row([[rt.label, rt.id, 'td', 'label'], ...sides.map(s => [String(s.counts[rt.id] || 0), s.counts[rt.id] ? rt.id : null])]));
  table.append(head, body);
}

// --- Games against people (online.js talks to the server) -----------------------------------
// While one is open, the board shows it instead of your game against Stockfish, which stays saved
// and comes back with "Back to Stockfish". Your own moves show at once and go to the server, which
// checks them and sends the game back to both players (and anyone watching) on its live stream.
const COLOR_NAME = { w: 'White', b: 'Black' };
const otherSide = c => (c === 'w' ? 'b' : 'w');
// "your friend" in a game by link, "your opponent" in one from Live games (who may be a stranger)
const them = () => (online && online.view.listed ? 'your opponent' : 'your friend');
const Them = () => them()[0].toUpperCase() + them().slice(1);
let clockTimer = null;
let notice = null;   // a one-off message for the status line (e.g. a link that doesn't work)

// Who a side is, for the player bars, the status line and the review
function sideName(c, short = false) {
  if (!online) return c === player ? 'You' : short ? 'Stockfish' : `Stockfish · level ${level}, ${LEVELS[level - 1].name}`;
  if (c === online.you) return 'You';
  const p = online.view.players[c];
  if (online.you) return p.name || (p.joined ? Them() : `Waiting for ${them()}…`);
  return p.name || (p.joined ? `Guest (${COLOR_NAME[c]})` : `Waiting (${COLOR_NAME[c]})`);
}
const possessive = c => (sideName(c, true) === 'You' ? 'Your' : `${sideName(c, true)}’s`);

// join: you chose to play it (from Live games), so there's no invitation to accept first
async function openOnline(id, { join = false } = {}) {
  stopEngine();
  dropReview();
  leaveOnline();
  let v;
  try {
    v = await getGame(id);
  } catch (e) {
    return backToStockfish(false, e.status === 404 ? 'That game link doesn’t work: there’s no such game.' : `Couldn’t open that game: ${e.message}`);
  }
  if (!v.you && v.status === 'waiting') {
    const side = v.players.w.joined ? 'b' : 'w';
    const yours = timeText(v.times[side]), theirs = timeText(v.times[otherSide(side)]);
    const same = yours === theirs ? `${yours} each` : `you ${yours}, them ${theirs}`;
    if (!join && !(await confirmBox(`You’re invited to play ${COLOR_NAME[side]} (${same}). Play?`, 'Play'))) return backToStockfish(true);
    try {
      await joinGame(id);
      v = await getGame(id);
    } catch (e) {
      return backToStockfish(true, `Couldn’t join that game: ${e.message}`);
    }
  }
  online = { id, you: v.you, view: v, at: performance.now(), stop: null, problem: null };
  document.body.classList.add('online');
  orientation = v.you === 'b' ? 'black' : 'white';
  cardClosed = false;
  view = null;
  online.stop = follow(id, applyView);
  applyView(v);
  clockTimer = setInterval(renderClocks, 200);
}

// The game as the server sent it
function applyView(v) {
  if (!online || v.id !== online.id) return;
  const wasOver = ['over', 'aborted'].includes(online.view.status) && game.history().length === v.moves.length;
  online.view = v;
  online.at = performance.now();
  if (v.you) online.you = v.you;   // the stream's copy says null: it's the same for everyone
  const have = game.history({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
  if (startFen() !== v.start || have.join(' ') !== v.moves.join(' ')) {
    const g = new Chess(v.start);
    for (const m of v.moves) g.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
    game = g;
    if (view !== null && view > v.moves.length) view = null;
  }
  for (const c of ['w', 'b']) game.setHeader(COLOR_NAME[c], v.players[c].name || (c === online.you ? 'You' : 'Guest'));
  game.setHeader('Site', 'chess.pacificfish.ca');
  player = online.you || 'w';
  result = onlineResult(v);
  game.setHeader('Result', result ? result.score : '*');
  if (result && !wasOver) cardClosed = false;
  render();
}

function onlineResult(v) {
  if (v.status === 'aborted') return { score: '*', winner: null, reason: 'aborted', text: 'The game was called off.' };
  if (v.status !== 'over' || !v.result) return null;
  const { winner, reason, points } = v.result, you = online.you;
  // Hexagonal chess scores a stalemate 3/4 to the side that gave it, 1/4 to the other
  const frac = p => ({ 0.25: '¼', 0.75: '¾' })[p] ?? String(p);
  const score = points ? `${frac(points.w)}-${frac(points.b)}` : winner === 'w' ? '1-0' : winner === 'b' ? '0-1' : '1/2-1/2';
  const wins = w => (w === you ? 'You win!' : you ? `${Them()} wins.` : `${COLOR_NAME[w]} wins.`);
  const loser = winner && otherSide(winner);
  const texts = {
    checkmate: () => `Checkmate. ${wins(winner)}`,
    resign: () => (loser === you ? 'You resigned.' : you ? `${Them()} resigned. You win!` : `${COLOR_NAME[loser]} resigned.`),
    time: () => (loser === you ? 'Your time ran out.' : you ? `${Them()} ran out of time. You win!` : `${COLOR_NAME[loser]} ran out of time.`),
    agreement: () => 'A draw, by agreement.',
    stalemate: () => (points
      ? `Stalemate: ${COLOR_NAME[points.w > points.b ? 'w' : 'b']} gave it, and scores ¾ to ¼.`
      : 'Stalemate: a draw.'),
    material: () => 'A draw: neither side has enough pieces left to checkmate.',
    repetition: () => 'A draw by repetition: the same position came up three times.',
    fifty: () => 'A draw by the fifty-move rule.',
  };
  return { score, winner, reason, text: (texts[reason] || (() => 'The game is over.'))() };
}

// Your move, at once on the board, then to the server; if it refuses (say the game ended just
// then), the board goes back to the server's game
async function sendMove(uci) {
  try {
    applyView(await act(online.id, 'move', { move: uci }));
  } catch (e) {
    if (!online) return;
    online.problem = e.message;
    try { applyView(await getGame(online.id)); } catch { render(); }
  }
}

async function onlineAction(action, ask) {
  if (!online) return;
  if (ask && !(await confirmBox(ask[0], ask[1]))) return;
  try { applyView(await act(online.id, action)); } catch (e) { online.problem = e.message; render(); }
}

function leaveOnline() {
  if (!online) return;
  online.stop?.();
  clearInterval(clockTimer);
  online = null;
  document.body.classList.remove('online');
  renderClocks();
}

// Back to your game against Stockfish, as it was saved
function backToStockfish(changeAddress = true, message = null) {
  leaveOnline();
  if (changeAddress && location.search) history.pushState(null, '', location.pathname);
  notice = message;
  dropReview();
  if (!load()) return newGame('w', 3);
  view = null;
  orientation = COLOR[player] || orientation;
  render();
  if (!result && game.turn() !== player) engineMove();
}

function onlineStatus() {
  const v = online.view, you = online.you, turn = game.turn();
  if (online.problem) return online.problem;
  if (result) return result.text;
  if (v.status === 'waiting') {
    if (!you) return 'Waiting for a second player.';
    return v.listed ? 'Waiting for an opponent: your game is in Live games. You can also send the link below.' : 'Waiting for your friend: send them the link below.';
  }
  let text = you ? (turn === you ? (game.inCheck() ? 'Check! Your move.' : 'Your move.') : `${Them()}’s move.`) : `${COLOR_NAME[turn]} to move.`;
  if (you && v.drawOffer === otherSide(you)) text = `${Them()} offers a draw.`;
  else if (you && v.drawOffer === you) text += ' You’ve offered a draw.';
  return text;
}

function renderOnline() {
  const box = $('online-box');
  box.hidden = !online;
  if (!online) return;
  const v = online.view, you = online.you, playing = v.status === 'playing';
  $('ob-link-row').hidden = !(you && v.status === 'waiting');
  $('ob-link').value = `${location.origin}/?g=${online.id}`;
  const theirOffer = you && playing && v.drawOffer === otherSide(you);
  $('ob-draw').hidden = !(you && playing) || theirOffer;
  $('ob-draw').disabled = v.drawOffer === you;
  $('ob-draw').textContent = v.drawOffer === you ? 'Draw offered' : 'Offer draw';
  $('ob-accept').hidden = $('ob-decline').hidden = !theirOffer;
  $('ob-abort').hidden = !(you && (v.status === 'waiting' || (playing && v.moves.length < 2)));
  $('ob-leave').textContent = 'Back to Stockfish';
}

// Each side's clock, counting down between the server's updates from what it last said (by this
// device's own timer, so its clock being off doesn't matter)
function renderClocks() {
  const bottom = orientation === 'white' ? 'w' : 'b';
  for (const [id, side] of [['bottom-player', bottom], ['top-player', otherSide(bottom)]]) {
    const el = $(id).querySelector('.clock');
    el.hidden = !online;
    if (!online) continue;
    const v = online.view;
    const running = v.running === side;
    const ms = v.clocks[side] - (running ? performance.now() - online.at : 0);
    el.textContent = clockText(ms);
    el.classList.toggle('running', running);
    el.classList.toggle('low', ms < 20_000 && v.status === 'playing');
  }
}

$('live-games').onclick = () => openLobby((id, how) => {
  history.pushState(null, '', `?g=${id}`);
  openOnline(id, { join: how === 'play' });
});
$('play-friend').onclick = async () => {
  const settings = await askForGame();
  if (!settings) return;
  try {
    const r = await createGame(settings);
    history.pushState(null, '', `?g=${r.id}`);
    await openOnline(r.id);
  } catch (e) {
    notice = `Couldn’t make the game: ${e.message}`;
    render();
  }
};
$('ob-copy').onclick = () => {
  const done = () => { $('ob-copy').textContent = 'Copied!'; setTimeout(() => { $('ob-copy').textContent = 'Copy link'; }, 1500); };
  navigator.clipboard?.writeText($('ob-link').value).then(done, () => $('ob-link').select()) ?? $('ob-link').select();
};
$('ob-draw').onclick = () => onlineAction('draw');
$('ob-accept').onclick = () => onlineAction('draw');
$('ob-decline').onclick = () => onlineAction('decline');
$('ob-abort').onclick = () => onlineAction('abort', ['Call off this game? It won’t count for either side.', 'Call off']);
$('ob-leave').onclick = async () => {
  if (online && online.you && online.view.status === 'playing'
    && !(await confirmBox('Leave this game? It goes on without you: your clock keeps running. You can come back by its link.', 'Leave'))) return;
  backToStockfish();
};
addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('g');
  if (id && (!online || online.id !== id)) openOnline(id);
  else if (!id && online) backToStockfish(false);
});

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
$('go-review').onclick = startReview;
$('review-game').onclick = startReview;
$('rv-exit').onclick = leaveReview;
$('rv-graph').onclick = e => {
  const r = e.currentTarget.getBoundingClientRect();
  show(Math.round(((e.clientX - r.left) / r.width) * game.history().length));
};
$('go-new').onclick = openNewGame;
$('go-close').onclick = () => { cardClosed = true; render(); };
$('undo').onclick = takeBack;
$('flip').onclick = () => { orientation = orientation === 'white' ? 'black' : 'white'; save(); render(); };
$('download').onclick = downloadPgn;
$('resign').onclick = async () => {
  if (online) return onlineAction('resign', [`Resign this game? ${Them()} will be given the win.`, 'Resign']);
  if (!(await confirmBox('Resign this game? Stockfish will be given the win.', 'Resign'))) return;
  stopEngine();
  finish(player === 'w' ? 'b' : 'w', 'resign', 'You resigned. Stockfish wins.');
  view = null;
  save();
  render();
};

// --- Start -----------------------------------------------------------------------------------
const engine = new Engine();
engine.ready.catch(engineBroke);   // e.g. its files didn't load: say so straight away, even on your move
if (load()) {
  render();
  if (!result && game.turn() !== player) engineMove();   // it was Stockfish's turn when the page closed
} else {
  newGame('w', 3);
}
accounts = initAccounts({ saved, useSaved });
// A game link (?g=...) opens that game against a person
const linked = new URLSearchParams(location.search).get('g');
if (linked) openOnline(linked);
