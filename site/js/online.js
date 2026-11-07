// Games against people, the page's side (the server's is server/games.mjs): making a game and its
// link, joining one, the live stream of the game, sending moves, and the clocks. app.js shows the game.
const $ = id => document.getElementById(id);
const SEATS = 'chess.seats.v1';   // game id -> { seat, color }: your seat key for each game you play

async function call(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'chess' }, body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* the status says enough */ }
  if (!res.ok) throw Object.assign(new Error(data.error || `The server answered ${res.status}.`), { status: res.status });
  return data;
}

const seats = () => { try { return JSON.parse(localStorage.getItem(SEATS) || '{}'); } catch { return {}; } };
export const seatFor = id => seats()[id]?.seat || null;
function keepSeat(id, seat, color) {
  if (!seat) return;
  const all = seats();
  all[id] = { seat, color };
  // keep the 50 newest, so this never grows without end
  const ids = Object.keys(all);
  for (const old of ids.slice(0, Math.max(0, ids.length - 50))) delete all[old];
  try { localStorage.setItem(SEATS, JSON.stringify(all)); } catch { /* signed in, your account finds your seat anyway */ }
}

export async function getGame(id) {
  const seat = seatFor(id);
  const res = await fetch(`/api/games/${encodeURIComponent(id)}`, { headers: seat ? { 'X-Seat': seat } : {} });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `The server answered ${res.status}.`), { status: res.status });
  return data;
}

export async function joinGame(id) {
  const r = await call(`/api/games/${encodeURIComponent(id)}/join`, { seat: seatFor(id) });
  keepSeat(id, r.seat, r.color);
  return r;
}

// move, resign, draw (offer, or accept theirs), decline, abort
export const act = (id, action, extra = {}) => call(`/api/games/${encodeURIComponent(id)}/${action}`, { seat: seatFor(id), ...extra });

// The game, live: calls onGame with the whole game each time it changes. EventSource reconnects by
// itself after a dropped connection, and the server sends the whole game again then.
export function follow(id, onGame) {
  const es = new EventSource(`/api/games/${encodeURIComponent(id)}/events`);
  es.addEventListener('game', e => { try { onGame(JSON.parse(e.data)); } catch { /* a broken message: the next one fixes it */ } });
  return () => es.close();
}

// 1:05:09, 4:07, or 0:08.3 in the last ten seconds
export function clockText(ms) {
  const t = Math.max(0, ms);
  if (t < 10_000) return `0:0${(Math.floor(t / 100) / 10).toFixed(1)}`;
  const s = Math.floor(t / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// "10+5": minutes and increment seconds
export function timeText({ base, inc }) {
  const min = base / 60_000;
  return `${Number.isInteger(min) ? min : min.toFixed(1)}+${inc / 1000}`;
}

// The "Play a friend" box: colour and each side's time control. Resolves with what to send, or null.
export function askForGame() {
  const box = $('friend-dialog');
  const same = $('fr-same');
  const field = id => $(id);
  const sync = () => {
    $('fr-black-row').hidden = same.checked;
    if (same.checked) { field('fr-b-min').value = field('fr-w-min').value; field('fr-b-inc').value = field('fr-w-inc').value; }
    $('fr-w-label').textContent = same.checked ? 'Both sides' : 'White';
  };
  same.onchange = sync;
  box.querySelectorAll('[data-preset]').forEach(b => {
    b.onclick = () => {
      const [min, inc] = b.dataset.preset.split('+');
      field('fr-w-min').value = min; field('fr-w-inc').value = inc;
      sync();
    };
  });
  field('fr-w-min').oninput = field('fr-w-inc').oninput = sync;
  sync();
  $('fr-error').textContent = '';
  box.returnValue = '';
  return new Promise(resolve => {
    box.addEventListener('close', () => {
      if (box.returnValue !== 'create') return resolve(null);
      const num = id => Number(field(id).value);
      resolve({
        color: box.querySelector('input[name=fr-side]:checked').value,
        times: { w: { minutes: num('fr-w-min'), increment: num('fr-w-inc') }, b: { minutes: num('fr-b-min'), increment: num('fr-b-inc') } },
      });
    }, { once: true });
    box.showModal();
  });
}

export async function createGame(settings) {
  const r = await call('/api/games', { variant: 'chess', ...settings });
  keepSeat(r.id, r.seat, r.color);
  return r;
}
