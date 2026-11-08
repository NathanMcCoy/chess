// The hexagonal chess page (/hex): Gliński's rules (variants/hex.js) on the hex board
// (boards/hexboard.js). Two players on one device, or you against the site's own bot (bot/worker.js),
// both kept in this browser; or a game against a person elsewhere (online.js talks to the server, as
// on the chess page): /hex?g=<id> opens one.
import hex from './variants/hex.js';
import { hexBoard } from './boards/hexboard.js';
import { getGame, joinGame, act, follow, clockText, timeText, askForGame, createGame, openLobby, gamePath } from './online.js';

const SAVE = 'chess.hex.v1';
const NAME = { w: 'White', b: 'Black' };
const other = c => (c === 'w' ? 'b' : 'w');
const $ = id => document.getElementById(id);
const MOVE = /^([a-l]\d{1,2})([a-l]\d{1,2})([qrbn]?)$/;

let game = { start: hex.start(), moves: [] };
let played = null;          // hex.replay of the game: states, names, result
let viewing = null;         // the move number being looked at, or null for the latest position
let orientation = 'w';      // who's at the bottom
let autoTurn = false;       // turn the board to whoever's move it is (two on one device)
let cardClosed = false;     // the result card was put away to look at the board
// A game against a person: { id, you: 'w' | 'b' | null (watching), view (the server's), at, stop, problem }.
// Your own two-player game stays saved meanwhile, and comes back when you leave.
let online = null;
let clockTimer = null;
let notice = null;          // a one-off message for the status line
// You against the site's bot: { side: the side you play, level }, or null for two players
let vsBot = null;
const LEVELS = { 1: { name: 'Quick', ms: 250 }, 2: { name: 'Normal', ms: 1000 }, 3: { name: 'Long', ms: 3000 } };

// --- Kept in this browser (the game on this device, two players or against the bot) -----------
function load() {
  game = { start: hex.start(), moves: [] };
  orientation = 'w';
  vsBot = null;
  try {
    const s = JSON.parse(localStorage.getItem(SAVE) || 'null');
    if (!s || s.variant !== 'hex' || typeof s.start !== 'string' || !Array.isArray(s.moves)) return;
    if (hex.replay(s.start, s.moves).error) return;   // damaged: start afresh
    game = { start: s.start, moves: s.moves };
    orientation = s.orientation === 'b' ? 'b' : 'w';
    autoTurn = s.autoTurn === true;
    cardClosed = s.cardClosed === true;
    if (s.vsBot && ['w', 'b'].includes(s.vsBot.side) && LEVELS[s.vsBot.level]) vsBot = { side: s.vsBot.side, level: s.vsBot.level };
  } catch { /* storage blocked or the save isn't JSON: a new game */ }
}
function save() {
  if (online) return;
  try { localStorage.setItem(SAVE, JSON.stringify({ variant: 'hex', start: game.start, moves: game.moves, orientation, autoTurn, cardClosed, vsBot })); } catch { /* storage blocked */ }
}

// --- Who's who, and how it ended ----------------------------------------------------------------
// "your friend" in a game by link, "your opponent" in one from Live games (who may be a stranger)
const them = () => (!online && vsBot ? 'the bot' : online?.view.listed ? 'your opponent' : 'your friend');
const Them = () => them()[0].toUpperCase() + them().slice(1);
function sideName(c) {
  if (!online && vsBot) return c === vsBot.side ? 'You' : `The bot (${LEVELS[vsBot.level].name})`;
  if (!online) return NAME[c];
  if (c === online.you) return 'You';
  const p = online.view.players[c];
  if (online.you) return p.name || (p.joined ? Them() : `Waiting for ${them()}…`);
  return p.name || (p.joined ? `Guest (${NAME[c]})` : `Waiting (${NAME[c]})`);
}

const frac = p => ({ 0: '0', 0.25: '¼', 0.5: '½', 0.75: '¾', 1: '1' })[p] ?? String(p);
// The result, said from your side when you're playing: { score, title, text, outcome }
function describe(r, you = null) {
  const points = r.points || (r.winner ? { [r.winner]: 1, [other(r.winner)]: 0 } : { w: 0.5, b: 0.5 });
  const score = `${frac(points.w)}–${frac(points.b)}`;
  const wins = w => (!you ? `${NAME[w]} wins` : w === you ? 'You win!' : `${Them()} wins`);
  const loser = r.winner && other(r.winner);
  const giver = points.w > points.b ? 'w' : 'b';
  const texts = {
    checkmate: () => [wins(r.winner), 'Checkmate.'],
    resign: () => [wins(r.winner), loser === you ? 'You resigned.' : you ? `${Them()} resigned.` : `${NAME[loser]} resigned.`],
    time: () => [wins(r.winner), loser === you ? 'Your time ran out.' : you ? `${Them()} ran out of time.` : `${NAME[loser]} ran out of time.`],
    stalemate: () => [!you ? `${NAME[giver]} scores ¾` : giver === you ? 'You score ¾' : `${Them()} scores ¾`,
      `Stalemate: ${NAME[other(giver)]} can’t move. In Gliński’s chess that scores ¾ to the side that gave it and ¼ to the other.`],
    agreement: () => ['Draw', 'A draw, by agreement.'],
    material: () => ['Draw', 'Neither side has enough pieces left to checkmate.'],
    repetition: () => ['Draw', 'A draw by repetition: the same position came up three times.'],
    fifty: () => ['Draw', 'A draw by the fifty-move rule.'],
  };
  const [title, text] = (texts[r.reason] || (() => ['Game over', '']))();
  const mine = you ? points[you] : null;
  const outcome = mine === null ? (r.winner ? 'win' : 'draw') : mine > 0.5 ? 'win' : mine < 0.5 ? 'loss' : 'draw';
  return { score, title, text, outcome };
}
// "White wins. Checkmate." but "You win! Checkmate.": a full stop only where the title has none
const sentence = o => `${/[.!?]$/.test(o.title) ? o.title : `${o.title}.`} ${o.text}`;
// How the game shown ended, or null while it's going on
function outcome() {
  if (!online) return played.result ? describe(played.result, vsBot ? vsBot.side : null) : null;
  const v = online.view;
  if (v.status === 'aborted') return { score: '*', title: 'Called off', text: 'The game was called off.', outcome: 'draw' };
  return v.status === 'over' && v.result ? describe(v.result, online.you) : null;
}

// --- Drawing it all -----------------------------------------------------------------------------
const board = hexBoard($('hexboard'), { geometry: hex.geometry, onMove: (from, to) => play(from, to) });

function render() {
  played = hex.replay(game.start, game.moves);
  if (played.error) played = hex.replay(game.start, []);   // can't happen: the server checks every move
  const n = played.states.length - 1;
  const at = viewing ?? n;
  const state = played.states[at];
  const turn = hex.turn(state);
  const pieces = hex.pieces(state);
  const over = outcome();
  const live = at === n && !over;
  // Who may move now: either side on one device; against the bot or online, only you, on your turn
  const canMove = live && (online ? online.view.status === 'playing' && online.you === turn : !vsBot || turn === vsBot.side);

  const dests = {};
  if (canMove) for (const m of hex.legal(state)) {
    const [, from, to] = m.match(MOVE);
    (dests[from] ||= []).includes(to) || dests[from].push(to);
  }
  const last = at > 0 ? game.moves[at - 1].match(MOVE) : null;
  const inCheck = hex.inCheck(state);
  const check = inCheck ? Object.keys(pieces).find(c => pieces[c] === (turn === 'w' ? 'K' : 'k')) : null;
  board.set({ pieces, dests, lastMove: last ? [last[1], last[2]] : null, check, orientation });

  // The status line, and the players either side of the board
  const status = $('status');
  status.classList.toggle('over', !!over && at === n);
  status.textContent = notice ?? (at < n
    ? (at === 0 ? 'Looking at the start. → to go on.' : `Looking at move ${Math.ceil(at / 2)}${at % 2 ? '' : '…'} ${played.names[at - 1]}.`)
    : online ? onlineStatus(over, turn, inCheck)
      : over ? sentence(over)
        : vsBot ? (turn === vsBot.side ? (inCheck ? 'Check! Your move.' : 'Your move.') : 'The bot is thinking…')
          : `${NAME[turn]} to move${inCheck ? ': in check!' : '.'}`);
  for (const [id, side] of [['top-player', other(orientation)], ['bottom-player', orientation]]) {
    const row = $(id);
    row.querySelector('.name').textContent = sideName(side);
    row.classList.toggle('to-move', live && turn === side && (!online || online.view.status === 'playing'));
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
  if (over) {
    const li = document.createElement('li');
    li.className = 'result';
    li.textContent = over.score;
    list.append(li);
  }
  // Keep the current move visible by scrolling the list itself, as the chess page does.
  // (scrollIntoView scrolled the whole page on a phone after every move: the user's iPhone, Nov 7.)
  const current = list.querySelector('.current');
  if (current) {
    const r = current.getBoundingClientRect(), box = list.getBoundingClientRect();
    if (r.top < box.top) list.scrollTop -= box.top - r.top;
    else if (r.bottom > box.bottom) list.scrollTop += r.bottom - box.bottom;
  }

  $('first').disabled = $('prev').disabled = at === 0;
  $('next').disabled = $('last').disabled = at === n;
  // Against the bot, Take back needs a move of yours to take back
  $('undo').disabled = !online && vsBot ? !game.moves.some((_, i) => plySide(i) === vsBot.side) : n === 0;
  $('auto-turn').checked = autoTurn;
  $('bot-row').hidden = !vsBot || !!online;
  if (vsBot) $('bot-about').textContent = `Playing the bot (${LEVELS[vsBot.level].name}) as ${NAME[vsBot.side]}.`;

  // The result card, over the board, until it's put away
  const box = $('gameover');
  box.hidden = !(over && at === n && !cardClosed);
  if (!box.hidden) {
    box.querySelector('.go-card').className = `go-card ${over.outcome}`;
    $('go-score').textContent = over.score;
    $('go-title').textContent = over.title;
    $('go-reason').textContent = over.text;
  }
  renderOnline();
  renderClocks();
  save();
  askBot();
}

// Which side played move i of this game (0 is the first)
const plySide = i => (i % 2 === 0 ? hex.turn(game.start) : other(hex.turn(game.start)));

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
  game = { ...game, moves: [...game.moves, move] };
  viewing = null;
  cardClosed = false;
  notice = null;
  if (online) { online.problem = null; render(); return sendMove(move); }
  if (autoTurn && !vsBot) orientation = hex.turn(hex.replay(game.start, game.moves).states.at(-1));
  render();
}

// --- The site's bot ------------------------------------------------------------------------------
// It thinks in a Web Worker. Each question has a number; an answer to anything but the latest is
// dropped, and taking back or starting again stops the worker, so an old answer can't land in a
// different game.
let botWorker = null;
let botAsked = 0;       // the latest question's number
let botFor = null;      // the game it's thinking about, so it isn't asked twice
function askBot() {
  if (!vsBot || online || played.result) return;
  if (hex.turn(played.states.at(-1)) === vsBot.side) return;
  const key = `${game.start} ${game.moves.join(' ')}`;
  if (botFor === key) return;
  botFor = key;
  const id = ++botAsked;
  botWorker ??= startBot();
  botWorker.postMessage({ id, variant: 'hex', start: game.start, moves: game.moves, timeMs: LEVELS[vsBot.level].ms });
}
function startBot() {
  const w = new Worker('/js/bot/worker.js', { type: 'module' });
  w.onmessage = ({ data }) => {
    if (data.id !== botAsked || !vsBot || online) return;
    document.body.dataset.botEngine = data.engine || '';   // which engine thought ('wasm' or 'js'): for the tests
    document.body.dataset.botJudge = data.judge || '';     // and by what ('net' or 'weights'; none for 'js')
    botFor = null;
    const legal = hex.legal(played.states.at(-1));
    if (data.error || !legal.includes(data.move)) {
      notice = `The bot couldn’t move (${data.error || 'it chose an impossible move'}). Take back or start a new game to try again.`;
      return render();
    }
    game = { ...game, moves: [...game.moves, data.move] };
    cardClosed = false;
    notice = null;
    render();
  };
  w.onerror = () => { botFor = null; notice = 'The bot couldn’t start. Reload the page to try again.'; render(); };
  return w;
}
// Forget any question in progress (the game it was about is changing)
function stopBot() {
  botAsked++;
  if (botFor && botWorker) { botWorker.terminate(); botWorker = null; }
  botFor = null;
}

// --- Games against people -----------------------------------------------------------------------
// join: you chose to play it (from Live games), so there's no invitation to accept first
async function openOnline(id, { join = false } = {}) {
  stopBot();   // a bot game here waits until you come back to it
  leaveOnline();
  let v;
  try {
    v = await getGame(id);
  } catch (e) {
    return backHere(false, e.status === 404 ? 'That game link doesn’t work: there’s no such game.' : `Couldn’t open that game: ${e.message}`);
  }
  // Square chess is played on the chess page
  if (v.variant !== 'hex') return location.replace(gamePath(id, v.variant) + (join ? '&join=1' : ''));
  if (!v.you && v.status === 'waiting') {
    const side = v.players.w.joined ? 'b' : 'w';
    const yours = timeText(v.times[side]), theirs = timeText(v.times[other(side)]);
    const same = yours === theirs ? `${yours} each` : `you ${yours}, them ${theirs}`;
    if (!join && !(await confirmBox(`You’re invited to play ${NAME[side]} in hexagonal chess (${same}). Play?`, 'Play'))) return backHere(true);
    try {
      await joinGame(id);
      v = await getGame(id);
    } catch (e) {
      return backHere(true, `Couldn’t join that game: ${e.message}`);
    }
  }
  online = { id, you: v.you, view: v, at: performance.now(), stop: null, problem: null };
  document.body.classList.add('online');
  orientation = v.you === 'b' ? 'b' : 'w';
  cardClosed = false;
  viewing = null;
  notice = null;
  online.stop = follow(id, applyView);
  applyView(v);
  clockTimer = setInterval(renderClocks, 200);
}

// The game as the server sent it
function applyView(v) {
  if (!online || v.id !== online.id) return;
  const wasOver = ['over', 'aborted'].includes(online.view.status);
  online.view = v;
  online.at = performance.now();
  if (v.you) online.you = v.you;   // the stream's copy says null: it's the same for everyone
  game = { start: v.start, moves: v.moves };
  if (viewing !== null && viewing > v.moves.length) viewing = null;
  if (['over', 'aborted'].includes(v.status) && !wasOver) cardClosed = false;
  render();
}

// Your move is on the board already; if the server refuses it (say the game ended just then), the
// board goes back to the server's game
async function sendMove(move) {
  const id = online.id;
  try {
    applyView(await act(id, 'move', { move }));
  } catch (e) {
    if (!online || online.id !== id) return;
    online.problem = e.message;
    try { applyView(await getGame(id)); } catch { render(); }
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
}

// Back to your own game on this device, as it was saved
function backHere(changeAddress = true, message = null) {
  leaveOnline();
  if (changeAddress && location.search) history.pushState(null, '', location.pathname);
  load();
  viewing = null;
  notice = message;
  render();
}

function onlineStatus(over, turn, inCheck) {
  const v = online.view, you = online.you;
  if (online.problem) return online.problem;
  if (over) return sentence(over);
  if (v.status === 'waiting') {
    if (!you) return 'Waiting for a second player.';
    return v.listed ? 'Waiting for an opponent: your game is in Live games. You can also send the link below.' : 'Waiting for your friend: send them the link below.';
  }
  let text = you ? (turn === you ? (inCheck ? 'Check! Your move.' : 'Your move.') : `${Them()}’s move.`) : `${NAME[turn]} to move.`;
  if (you && v.drawOffer === other(you)) text = `${Them()} offers a draw.`;
  else if (you && v.drawOffer === you) text += ' You’ve offered a draw.';
  return text;
}

function renderOnline() {
  const box = $('online-box');
  box.hidden = !online;
  $('auto-turn-row').hidden = !!online || !!vsBot;   // against the bot, your side stays at the bottom
  if (!online) return;
  const v = online.view, you = online.you, playing = v.status === 'playing';
  $('ob-link-row').hidden = !(you && v.status === 'waiting');
  $('ob-link').value = `${location.origin}${gamePath(online.id, 'hex')}`;
  const theirOffer = you && playing && v.drawOffer === other(you);
  $('ob-draw').hidden = !(you && playing) || theirOffer;
  $('ob-draw').disabled = v.drawOffer === you;
  $('ob-draw').textContent = v.drawOffer === you ? 'Draw offered' : 'Offer draw';
  $('ob-accept').hidden = $('ob-decline').hidden = !theirOffer;
  $('ob-abort').hidden = !(you && (v.status === 'waiting' || (playing && v.moves.length < 2)));
  $('ob-resign').hidden = !(you && playing && v.moves.length >= 2);
}

// Each side's clock, counting down between the server's updates from what it last said (by this
// device's own timer, so its clock being off doesn't matter)
function renderClocks() {
  for (const [id, side] of [['bottom-player', orientation], ['top-player', other(orientation)]]) {
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
  // From a finished game against a person (its result card): back to this device's own game first,
  // shown behind the question if it's one that would be lost
  if (online) backHere();
  const unfinished = game.moves.length && !hex.replay(game.start, game.moves).result;
  if (unfinished && !(await confirmBox('Start a new game? This one will be lost.', 'New game'))) return;
  stopBot();
  game = { start: hex.start(), moves: [] };
  viewing = null;
  cardClosed = false;
  // Said every time: on a board that was already empty, nothing else would show it worked. Against
  // the bot playing White, its first move shows it instead.
  notice = !vsBot ? 'New game started. White to move.' : vsBot.side === 'w' ? 'New game against the bot. Your move.' : null;
  if (vsBot) orientation = vsBot.side;
  else if (autoTurn) orientation = 'w';
  render();
}

// Play the bot: your side and how long it thinks, then a new game against it
function playBot() {
  const box = $('bot-dialog');
  const form = box.querySelector('form');
  if (vsBot) {
    form.querySelector(`input[name=bot-side][value="${vsBot.side}"]`).checked = true;
    form.querySelector(`input[name=bot-level][value="${vsBot.level}"]`).checked = true;
  }
  box.returnValue = '';
  box.addEventListener('close', async () => {
    if (box.returnValue !== 'start') return;
    let side = form.querySelector('input[name=bot-side]:checked').value;
    if (side === 'random') side = Math.random() < 0.5 ? 'w' : 'b';
    const level = Number(form.querySelector('input[name=bot-level]:checked').value);
    const unfinished = game.moves.length && !hex.replay(game.start, game.moves).result;
    if (unfinished && !(await confirmBox('Start a game against the bot? The game on the board will be lost.', 'Play the bot'))) return;
    vsBot = { side, level };
    stopBot();
    game = { start: hex.start(), moves: [] };
    viewing = null;
    cardClosed = false;
    orientation = side;
    notice = side === 'w' ? 'You play White against the bot. Your move.' : null;
    render();
  }, { once: true });
  box.showModal();
}

// --- Buttons and keys ---------------------------------------------------------------------------
$('new-game').onclick = newGame;
$('go-new').onclick = newGame;
$('go-close').onclick = () => { cardClosed = true; render(); };
$('undo').onclick = () => {
  if (online) return;
  stopBot();
  let moves = game.moves.slice(0, -1);
  // Against the bot: back to your own last move (yours and its reply, or just yours while it thinks)
  if (vsBot) while (moves.length && plySide(moves.length) !== vsBot.side) moves = moves.slice(0, -1);
  game = { ...game, moves };
  viewing = null;
  cardClosed = false;
  notice = null;
  if (autoTurn && !vsBot) orientation = hex.turn(hex.replay(game.start, game.moves).states.at(-1));
  render();
};
$('play-bot').onclick = playBot;
$('bot-off').onclick = () => {
  stopBot();
  vsBot = null;
  notice = 'Two players on this device now: carry on from here.';
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

$('play-friend').onclick = async () => {
  const settings = await askForGame('hex');
  if (!settings) return;
  try {
    const r = await createGame(settings);
    if (settings.variant !== 'hex') return location.assign(gamePath(r.id, settings.variant));
    history.pushState(null, '', gamePath(r.id, 'hex'));
    await openOnline(r.id);
  } catch (e) {
    notice = `Couldn’t make the game: ${e.message}`;
    render();
  }
};
$('live-games').onclick = () => openLobby((id, how, variant) => {
  if (variant !== 'hex') return location.assign(gamePath(id, variant) + (how === 'play' ? '&join=1' : ''));
  history.pushState(null, '', gamePath(id, 'hex'));
  openOnline(id, { join: how === 'play' });
});
$('ob-copy').onclick = () => {
  const done = () => { $('ob-copy').textContent = 'Copied!'; setTimeout(() => { $('ob-copy').textContent = 'Copy link'; }, 1500); };
  navigator.clipboard?.writeText($('ob-link').value).then(done, () => $('ob-link').select()) ?? $('ob-link').select();
};
$('ob-draw').onclick = () => onlineAction('draw');
$('ob-accept').onclick = () => onlineAction('draw');
$('ob-decline').onclick = () => onlineAction('decline');
$('ob-abort').onclick = () => onlineAction('abort', ['Call off this game? It won’t count for either side.', 'Call off']);
$('ob-resign').onclick = () => onlineAction('resign', [`Resign this game? ${Them()} will be given the win.`, 'Resign']);
$('ob-leave').onclick = async () => {
  if (online && online.you && online.view.status === 'playing'
    && !(await confirmBox('Leave this game? It goes on without you: your clock keeps running. You can come back by its link.', 'Leave'))) return;
  backHere();
};
addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('g');
  if (id && (!online || online.id !== id)) openOnline(id);
  else if (!id && online) backHere(false);
});

// --- Starting up --------------------------------------------------------------------------------
load();
render();
const params = new URLSearchParams(location.search);
if (params.get('g')) {
  const join = params.get('join') === '1';
  if (join) history.replaceState(null, '', gamePath(params.get('g'), 'hex'));   // a reload shouldn't join again
  openOnline(params.get('g'), { join });
} else if (params.has('new')) {
  // "New game" on the chess page, with hexagonal chess chosen
  history.replaceState(null, '', location.pathname);
  newGame();
}
