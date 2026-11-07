// Accounts on the page: signing up and in with a secret opening (a few moves, both sides, played on
// a small board), and keeping your current game in your account so it follows you between devices.
// The server side is server/accounts.mjs and server/api.mjs.
//
// Keeping the game in step: every save on this device is marked "not yet sent" until the server
// has it. On load, a device with unsent changes sends them; otherwise it takes the account's copy.
// Signing in on another device takes the account's game; signing up gives the new account the game
// on this device (a guest's game is claimed).
import { Chess } from '../vendor/chess.js';
import { Chessground } from '../vendor/chessground.js';
import { loadBook, openingStrength } from './opening.js';

const $ = id => document.getElementById(id);
const SYNC = 'chess.sync.v1';      // { name, dirty, updated }: this device's place in keeping up with the account
const VARIANT = 'chess';
const PRACTICE = 2;                // times you play a new opening again, from memory, before it's saved

async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'chess' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* not JSON: the status says enough */ }
  if (!res.ok) throw Object.assign(new Error(data.error || `The server answered ${res.status}.`), { status: res.status });
  return data;
}

const readSync = () => { try { return JSON.parse(localStorage.getItem(SYNC) || 'null') || {}; } catch { return {}; } };
const writeSync = s => { try { localStorage.setItem(SYNC, JSON.stringify(s)); } catch { /* not kept: only costs a re-send */ } };

// A small board where both sides' moves are played from the start: the opening being entered
function openingPad(el, onChange) {
  let pos = new Chess();
  let moves = [];
  const cg = Chessground(el, {
    coordinates: false,
    animation: { duration: 120 },
    movable: { free: false, showDests: true, events: { after: (from, to) => play(from, to) } },
    premovable: { enabled: false },
    drawable: { enabled: false },
  });
  const dests = () => {
    const d = new Map();
    for (const m of pos.moves({ verbose: true })) d.set(m.from, [...(d.get(m.from) || []), m.to]);
    return d;
  };
  // notify: false only for the first drawing, before anyone can be listening
  const sync = (notify = true) => {
    const last = pos.history({ verbose: true }).at(-1);
    const turn = pos.turn() === 'w' ? 'white' : 'black';
    cg.set({ fen: pos.fen(), turnColor: turn, lastMove: last ? [last.from, last.to] : undefined, movable: { color: turn, dests: dests() } });
    if (notify) onChange(moves);
  };
  function play(from, to) {
    // A pawn reaching the end becomes a queen: openings rarely get that far, and it keeps entering simple
    const piece = pos.get(from);
    const promotion = piece && piece.type === 'p' && (to[1] === '8' || to[1] === '1') ? 'q' : undefined;
    try { pos.move({ from, to, promotion }); } catch { return sync(); }
    moves.push(from + to + (promotion || ''));
    sync();
  }
  sync(false);
  return {
    moves: () => moves.slice(),
    names: () => pos.history(),
    undo() { if (moves.length) { pos.undo(); moves.pop(); sync(); } },
    clear() { pos = new Chess(); moves = []; sync(); },
    redraw() { cg.redrawAll(); },
  };
}

// "Sign out?", in the site's own confirm box (the one Resign uses), never a browser popup
function confirmSignOut() {
  const box = $('confirm');
  $('confirm-text').textContent = 'Sign out? Your game stays in your account, and on this device.';
  $('confirm-yes').textContent = 'Sign out';
  box.returnValue = '';
  return new Promise(resolve => {
    box.addEventListener('close', () => resolve(box.returnValue === 'yes'), { once: true });
    box.showModal();
  });
}

const moveText = names => names.map((n, i) => (i % 2 ? n : `${i / 2 + 1}. ${n}`)).join(' ');
const same = (a, b) => a.length === b.length && a.every((m, i) => m === b[i]);

export function initAccounts({ saved, useSaved }) {
  let me = null;         // your name when signed in
  let available = false; // the server keeps accounts (it doesn't when run without a data folder)
  let pushTimer = null;
  let book = null;

  // --- The header: "Sign in", or your name and "Sign out" ---
  const showWho = () => {
    $('acc-open').hidden = !available || !!me;
    $('acc-who').hidden = !me;
    $('acc-out').hidden = !me;
    $('acc-who').textContent = me || '';
  };

  // --- Keeping the game in your account ---
  async function push() {
    clearTimeout(pushTimer);
    if (!me) return;
    try {
      const r = await api('/api/game', { data: saved() }, 'PUT');
      writeSync({ name: me, dirty: false, updated: r.updated });
    } catch (e) {
      if (e.status === 401) { me = null; showWho(); }   // signed out elsewhere, or the session ran out
      /* otherwise offline or the server's down: it stays "not yet sent" and goes next time */
    }
  }
  async function pull() {
    const r = await api('/api/game');
    if (r.data) { useSaved(r.data); writeSync({ name: me, dirty: false, updated: r.updated }); return true; }
    return false;
  }
  // When the page opens signed in: send this device's unsent changes, or take the account's newer copy
  async function catchUp() {
    const s = readSync();
    if (s.name === me && s.dirty) return push();
    const r = await api('/api/game');
    if (!r.data) return push();   // nothing in the account yet: give it this game
    if (r.updated !== s.updated || s.name !== me) { useSaved(r.data); writeSync({ name: me, dirty: false, updated: r.updated }); }
  }

  // --- The dialog ---
  const dlg = $('account');
  let mode = 'signin';   // 'signin' or 'signup'
  let step = 'choose';   // signing up: 'choose', then 'practice' (PRACTICE times)
  let chosen = null;     // the opening being practiced
  let practiced = 0;
  const pad = openingPad($('acc-board'), moves => { $('acc-error').textContent = ''; describe(moves); });

  async function getBook() {
    if (!book) {
      try { book = loadBook(await (await fetch('data/book.json')).json()); } catch { book = false; }
    }
    return book;
  }

  async function describe(moves) {
    const practicing = mode === 'signup' && step === 'practice';
    // While practicing the moves aren't shown: it's from memory
    $('acc-moves').textContent = practicing ? `${moves.length} move${moves.length === 1 ? '' : 's'} played` : moveText(pad.names()) || ' ';
    const meter = $('acc-meter');
    meter.hidden = !(mode === 'signup' && step === 'choose');
    if (meter.hidden) return;
    const b = await getBook();
    const s = b ? openingStrength(moves, b, VARIANT) : { level: 'none', message: moves.length ? '' : 'Play your opening on the board.' };
    meter.dataset.level = s.level;
    meter.querySelector('p').textContent = s.message;
  }

  function setUp() {
    const signup = mode === 'signup';
    for (const t of dlg.querySelectorAll('[data-tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === mode));
    $('acc-name').autocomplete = signup ? 'off' : 'username';
    let text, go;
    if (!signup) { text = 'Play your secret opening: both sides’ moves, from the start.'; go = 'Sign in'; }
    else if (step === 'choose') { text = 'Choose your secret opening: play both sides’ moves, from the start. It’s your password, so pick one you’ll remember.'; go = 'Next: practice it'; }
    else { text = `Now play it again from memory (${practiced + 1} of ${PRACTICE}).`; go = practiced + 1 < PRACTICE ? 'Check' : 'Check and create account'; }
    $('acc-step').textContent = text;
    $('acc-go').textContent = go;
    $('acc-again').hidden = !(signup && step === 'practice');
    describe(pad.moves());
    // chessground remembers where the board is on screen and only re-measures on a resize or scroll:
    // if the box's layout moved it, taps would land on the wrong squares
    requestAnimationFrame(() => pad.redraw());
  }

  function open(which = 'signin') {
    mode = which; step = 'choose'; chosen = null; practiced = 0;
    $('acc-error').textContent = '';
    pad.clear();
    dlg.showModal();
    setUp();   // after showing the box: its board is measured again on the next screen refresh
    $('acc-name').focus();
  }

  async function go() {
    const name = $('acc-name').value.trim();
    const moves = pad.moves();
    const fail = text => { $('acc-error').textContent = text; };
    if (!name) return fail('Type your name.');
    if (!moves.length) return fail('Play at least one move.');
    $('acc-go').disabled = true;
    try {
      if (mode === 'signin') {
        me = (await api('/api/signin', { name, secret: { variant: VARIANT, moves } })).name;
        writeSync({ name: me, dirty: false, updated: null });
        dlg.close();
        showWho();
        if (!(await pull())) await push();   // the account's game if it has one, else this one
        return;
      }
      if (step === 'choose') {
        chosen = moves; step = 'practice'; practiced = 0;
        pad.clear();
        return setUp();
      }
      if (!same(moves, chosen)) {
        pad.clear();
        return fail('That’s not the same as your opening. Try again, or choose a different one.');
      }
      practiced++;
      pad.clear();
      if (practiced < PRACTICE) return setUp();
      me = (await api('/api/signup', { name, secret: { variant: VARIANT, moves: chosen } })).name;
      writeSync({ name: me, dirty: true, updated: null });
      dlg.close();
      showWho();
      await push();   // your game on this device becomes your account's
    } catch (e) {
      // A taken name only shows at the end of signing up: go back to choosing, keeping the opening
      if (e.status === 409) { step = 'choose'; practiced = 0; setUp(); }
      fail(e.message);
    } finally {
      $('acc-go').disabled = false;
    }
  }

  dlg.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) open(tab.dataset.tab);
  });
  $('acc-go').onclick = go;
  $('acc-undo').onclick = () => pad.undo();
  $('acc-clear').onclick = () => pad.clear();
  $('acc-again').onclick = () => { step = 'choose'; chosen = null; practiced = 0; pad.clear(); setUp(); };
  $('acc-cancel').onclick = () => dlg.close();
  $('acc-open').onclick = () => open('signin');
  $('acc-out').onclick = async () => {
    if (!(await confirmSignOut())) return;
    await push();   // anything not yet sent goes before signing out
    try { await api('/api/signout', {}); } catch { /* the cookie goes anyway when it runs out */ }
    me = null;
    writeSync({});
    showWho();
  };

  // --- Start: are accounts available, and am I signed in? ---
  api('/api/me').then(async r => {
    available = true;
    me = r.name;
    showWho();
    if (me) await catchUp();
  }).catch(() => { available = false; showWho(); });

  return {
    // app.js calls this after every save
    saved() {
      if (!me) return;
      writeSync({ ...readSync(), name: me, dirty: true });
      clearTimeout(pushTimer);
      pushTimer = setTimeout(push, 800);   // a burst of saves goes as one
    },
  };
}
