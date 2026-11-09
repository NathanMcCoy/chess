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

// The "Play a friend" box: which game, colour and each side's time control. Resolves with what to
// send, or null. `variant` is the game ticked when it opens (the page's own). `preset`: the same box
// for a rematch (rematchPreset: its game, side and both time controls filled in; no Live games)
export function askForGame(variant = 'chess', preset = null) {
  const box = $('friend-dialog');
  const pickVariant = box.querySelector(`input[name=fr-variant][value="${preset ? preset.variant : variant}"]`);
  if (pickVariant) pickVariant.checked = true;
  const same = $('fr-same');
  const field = id => $(id);
  // The box's own words, kept to put back after a rematch
  const title = box.querySelector('h2'), help = box.querySelector('.fr-help'), submit = box.querySelector('button[value=create]');
  for (const el of [title, help, submit]) el.dataset.text ??= el.textContent;
  title.textContent = preset ? 'Rematch' : title.dataset.text;
  help.textContent = preset ? 'They see the offer straight away, and can accept or decline it. Change anything you like.' : help.dataset.text;
  submit.textContent = preset ? 'Offer the rematch' : submit.dataset.text;
  box.querySelector('.fr-listed').hidden = !!preset;
  if (preset) {
    box.querySelector(`input[name=fr-side][value="${preset.color}"]`).checked = true;
    const t = preset.times;
    field('fr-w-min').value = t.w.base / 60_000; field('fr-w-inc').value = t.w.inc / 1000;
    field('fr-b-min').value = t.b.base / 60_000; field('fr-b-inc').value = t.b.inc / 1000;
    same.checked = t.w.base === t.b.base && t.w.inc === t.b.inc;
  }
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
        variant: box.querySelector('input[name=fr-variant]:checked')?.value || variant,
        listed: !preset && $('fr-listed').checked,
        color: box.querySelector('input[name=fr-side]:checked').value,
        times: { w: { minutes: num('fr-w-min'), increment: num('fr-w-inc') }, b: { minutes: num('fr-b-min'), increment: num('fr-b-inc') } },
      });
    }, { once: true });
    box.showModal();
  });
}

// Both sides' times: "10+5 each", or "White 3+2, Black 10+5"
const bothTimes = t => (timeText(t.w) === timeText(t.b) ? `${timeText(t.w)} each` : `White ${timeText(t.w)}, Black ${timeText(t.b)}`);
const SIDE = { w: 'White', b: 'Black' };
// Which game it is, before its details: only hexagonal chess says so, as most games are chess
const kind = g => (g.variant === 'hex' ? 'Hexagonal · ' : '');
// Where a game is played: chess on the main page, hexagonal chess on /hex
export const gamePath = (id, variant) => `${variant === 'hex' ? '/hex' : '/'}?g=${encodeURIComponent(id)}`;

// The Live games box: open games (Play) and games being played (Watch), kept up to date from the
// server's live list while it's open. onPick(id, how, variant) is called with 'play' or 'watch'.
export function openLobby(onPick) {
  const box = $('lobby');
  const row = (id, who, detail, label, pick) => {
    const li = document.createElement('li');
    li.dataset.id = id;
    const what = document.createElement('div');
    what.className = 'lg-what';
    const a = document.createElement('div'); a.className = 'lg-who'; a.textContent = who;
    const b = document.createElement('div'); b.className = 'lg-detail'; b.textContent = detail;
    what.append(a, b);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.className = label === 'Play' ? 'primary' : '';
    button.onclick = pick;
    li.append(what, button);
    return li;
  };
  const show = ({ open, live }) => {
    $('lobby-open').replaceChildren(...open.map(g => row(g.id, g.by, `${kind(g)}You’d play ${SIDE[g.side]} · ${bothTimes(g.times)}`, 'Play', () => done(g, 'play'))));
    $('lobby-live').replaceChildren(...live.map(g => row(g.id, `${g.players.w} vs ${g.players.b}`,
      `${kind(g)}${bothTimes(g.times)} · ${g.moves} move${g.moves === 1 ? '' : 's'}, ${SIDE[g.turn]} to move`, 'Watch', () => done(g, 'watch'))));
    $('lobby-open-none').hidden = open.length > 0;
    $('lobby-live-none').hidden = live.length > 0;
  };
  const es = new EventSource('/api/lobby/events');
  es.addEventListener('lobby', e => { try { show(JSON.parse(e.data)); } catch { /* the next one fixes it */ } });
  let picked = null;
  const done = (g, how) => { picked = { id: g.id, how, variant: g.variant || 'chess' }; box.close(); };
  $('lobby-close').onclick = () => box.close();
  box.addEventListener('close', () => { es.close(); if (picked) onPick(picked.id, picked.how, picked.variant); }, { once: true });
  show({ open: [], live: [] });
  box.showModal();
}

export async function createGame(settings) {
  const r = await call('/api/games', { variant: 'chess', ...settings });   // settings.variant, if given, wins
  keepSeat(r.id, r.seat, r.color);
  return r;
}

// --- Rematches --------------------------------------------------------------------------------
// After a game against a person, either player may offer a rematch: a new game with settings chosen
// afresh (the Play a friend box, filled in from the last game: sides swapped, each keeping their
// time control). The offerer goes to the new game to wait; the other sees the offer on the finished
// game (its live stream says so) and accepts, joining with their seat key from that game as proof,
// or declines. Both pages (chess and hex) have the same boxes and buttons, so this works for both.
const enc = encodeURIComponent;
export async function offerRematch(oldId, settings) {
  const r = await call(`/api/games/${enc(oldId)}/rematch`, { seat: seatFor(oldId), ...settings });
  keepSeat(r.id, r.seat, r.color);
  return r;
}
async function acceptRematch(offer, oldId) {
  const r = await call(`/api/games/${enc(offer.id)}/join`, { seat: seatFor(offer.id), proof: seatFor(oldId) });
  keepSeat(offer.id, r.seat, r.color);
  return r;
}
const declineRematch = (offer, oldId) => call(`/api/games/${enc(offer.id)}/refuse`, { proof: seatFor(oldId) });

// The box's settings for a rematch of finished game v, which you played as `you`: the same game,
// sides swapped, each player keeping the time control they had. (`you` comes from the page, not
// v.you: the live stream's copy of a game says null there, as it goes to everyone watching too.)
export function rematchPreset(v, you) {
  const them = you === 'w' ? 'b' : 'w';
  return { rematch: true, variant: v.variant, color: them, times: { [them]: v.times[you], [you]: v.times[them] } };
}
const gameName = variant => (variant === 'hex' ? 'Hexagonal chess' : 'Chess');
// "Hexagonal chess, you'd play White, 10+5 each"
export const offerText = offer => `${gameName(offer.variant)}, you’d play ${SIDE[offer.side]}, ${bothTimes(offer.times)}`;

// Where a finished game against a person stands for a rematch, from your side:
//   offer: may offer one; toYou: theirs is waiting for you; yours: yours is waiting; played: it's
//   being played or over; declined: yours was declined; withdrawn: theirs was called off
export function rematchState(o) {
  const v = o && o.view;
  if (!v || !o.you || !['over', 'aborted'].includes(v.status)) return {};
  const r = v.rematch;
  const both = v.players.w.joined && v.players.b.joined;
  const mine = r && r.by === o.you;
  return {
    r,
    offer: both && (!r || r.status === 'aborted'),
    toYou: !!r && r.status === 'waiting' && !mine,
    yours: !!r && r.status === 'waiting' && mine,
    played: !!r && ['playing', 'over'].includes(r.status),
    declined: !!r && r.status === 'aborted' && r.reason === 'declined' && mine,
    withdrawn: !!r && r.status === 'aborted' && r.reason !== 'declined' && !mine,
  };
}

// The rematch buttons on either page: on the result card, New game becomes Rematch… (or Accept
// rematch, with Decline beside it, when theirs is waiting); the online box has the same. `current()`
// is the page's game against a person (or null), `open(id, variant)` opens a game (on the other
// page if it's the other game), `problem(text)` shows a message, `Them()` names the other player.
export function rematchButtons({ current, open, problem, Them }) {
  const card = $('go-new');
  card.dataset.label ??= card.textContent;   // the page's own "New game"
  const go = async (what) => {
    const o = current();
    const s = rematchState(o);
    try {
      if (what === 'offer') {
        const settings = await askForGame(o.view.variant, rematchPreset(o.view, o.you));
        if (!settings) return;
        const r = await offerRematch(o.id, settings);
        return open(r.id, r.variant);
      }
      if (what === 'accept') { await acceptRematch(s.r, o.id); return open(s.r.id, s.r.variant); }
      if (what === 'decline') {
        await declineRematch(s.r, o.id);
        // Shown at once, not when the live stream next says so (a moment later)
        if (current() === o) { o.view = { ...o.view, rematch: { ...s.r, status: 'aborted', reason: 'declined' } }; problem(null); }
      }
      if (what === 'see') return open(s.r.id, s.r.variant);
    } catch (e) { problem(e.message); }
  };
  $('ob-rematch').onclick = () => go('offer');
  $('ob-rematch-accept').onclick = () => go('accept');
  $('ob-rematch-decline').onclick = $('go-decline').onclick = () => go('decline');
  $('ob-rematch-see').onclick = () => go('see');
  return {
    // What the card's New game button should do now: 'offer', 'accept', 'see' or null (the page's own)
    cardAction() { const s = rematchState(current()); return s.toYou ? 'accept' : s.yours || s.played ? 'see' : s.offer ? 'offer' : null; },
    click: what => go(what),
    // A line for the status, or null
    status() {
      const s = rematchState(current());
      if (s.toYou) return `${Them()} offers a rematch: ${offerText(s.r)}.`;
      if (s.yours) return 'Your rematch offer is waiting for an answer.';
      if (s.played) return 'The rematch is on.';
      if (s.declined) return `${Them()} declined the rematch.`;
      if (s.withdrawn) return `${Them()} called off the rematch offer.`;
      return null;
    },
    render() {
      const s = rematchState(current());
      const action = this.cardAction();
      card.textContent = { offer: 'Rematch…', accept: 'Accept rematch', see: 'Go to the rematch' }[action] || card.dataset.label;
      // An offer waiting for you: the card says what it is (on a phone the box below is out of
      // sight), and Accept is its main button. (Each page sets the card's text afresh before this.)
      if (s.toYou && !$('gameover').hidden) $('go-reason').textContent += ` ${Them()} offers a rematch: ${offerText(s.r)}.`;
      card.classList.toggle('primary', action === 'accept');
      $('go-review').classList.toggle('primary', action !== 'accept');
      $('go-decline').hidden = !s.toYou;
      $('ob-rematch').hidden = !s.offer || s.toYou;
      $('ob-rematch-accept').hidden = $('ob-rematch-decline').hidden = !s.toYou;
      $('ob-rematch-see').hidden = !(s.yours || s.played);
    },
  };
}
