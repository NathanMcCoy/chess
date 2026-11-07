// The site in real browsers, on phone and desktop screens, all at once: `npm test`.
// iPhone runs in WebKit (Safari's engine), Android and Desktop in Chromium. Each device is its own
// browser with its own saved game, so they can't affect each other. A failure names the device and
// the test line, and saves a screenshot as tests/shots/<device>-failed.png.
import { chromium, webkit, devices } from 'playwright';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../server/server.mjs';   // the real server, as deployed
import { Chess } from '../site/vendor/chess.js';   // to check that suggested moves are legal

const SHOTS = fileURLToPath(new URL('./shots/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });
const DEVICES = {
  iPhone: { engine: webkit, device: devices['iPhone 14'] },
  Android: { engine: chromium, device: devices['Pixel 7'] },
  Desktop: { engine: chromium, device: { viewport: { width: 1280, height: 800 } }, mouse: true },
};
const SAVE = 'chess.game.v1';
let passes = 0, fails = 0;
const check = (who, ok, name, extra = '') => {
  if (ok) passes++; else fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${who}] ${name}${extra ? ` ${extra}` : ''}`);
};

// The centre of a square on screen, whichever way round the board is
// `on` is which board: the game's (#board) or the account box's (#acc-board)
async function square(page, sq, on = '#board') {
  // Back to the top first, as a player would: clicking buttons lower down scrolls the page, and a
  // reload keeps that scroll position (the account box floats over the page, so no need there)
  if (on === '#board') await page.evaluate(() => window.scrollTo(0, 0));
  // The board can be mid-rebuild for a frame (chessground's redrawAll, when the account box
  // re-measures it): if so, look again a moment later
  let box = null;
  for (let i = 0; i < 10 && !box; i++) box = await page.locator(`${on} cg-board`).boundingBox() || (await page.waitForTimeout(30), null);
  const black = await page.locator(`${on}.orientation-black`).count();
  const f = sq.charCodeAt(0) - 97, r = Number(sq[1]) - 1, size = box.width / 8;
  const col = black ? 7 - f : f, row = black ? r : 7 - r;
  return { x: box.x + (col + 0.5) * size, y: box.y + (row + 0.5) * size };
}
async function tap(page, sq, touch, on) {
  const { x, y } = await square(page, sq, on);
  if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
}
async function move(page, from, to, touch, on) { await tap(page, from, touch, on); await tap(page, to, touch, on); }
// A sequence of moves in UCI ("e2e4 e7e5") on the account box's board, 50 ms apart: the board needs
// one screen refresh (about 16 ms) after a move before it takes the next, and with no gap at all
// automation tapped the other colour's piece before that and the move was lost. No person taps two
// squares within 16 ms. (Found Nov 6, after two wrong guesses at the cause.)
async function playOpening(page, uci, touch) {
  for (const m of uci.split(' ')) {
    await move(page, m.slice(0, 2), m.slice(2, 4), touch, '#acc-board');
    await page.waitForTimeout(50);
  }
}
const moveCount = page => page.locator('#moves button').count();
const waitMoves = (page, n, why) => page.waitForFunction(n => document.querySelectorAll('#moves button').length === n, n, { timeout: 15000 })
  .catch(async () => { throw new Error(`waiting for ${n} moves (${why}); the list has ${await moveCount(page)}, status: ${await status(page)}`); });
const status = page => page.locator('#status').innerText();
async function seed(page, saved) {
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [SAVE, saved]);
  await page.reload();
  await page.locator('#board cg-board piece').first().waitFor();
}

async function flow(page, who, { touch, mouse, freshPage }) {
  await page.goto('/');
  await page.locator('#board cg-board piece').first().waitFor();
  check(who, await page.locator('#board cg-board piece').count() === 32, 'the board starts with 32 pieces');
  check(who, (await status(page)) === 'Your move.', 'and says it is your move', await status(page));
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(who, over <= 0, 'nothing is wider than the screen', `${over}px over`);
  const board = await page.locator('#board cg-board').boundingBox();
  check(who, Math.abs(board.width - board.height) < 2 && board.width >= 300, 'the board is square and big enough', `${Math.round(board.width)}×${Math.round(board.height)}`);
  // Every coordinate label is inside the board and not the colour of the square it sits on
  const labels = await page.evaluate(() => {
    const b = document.querySelector('#board cg-board').getBoundingClientRect();
    const sq = getComputedStyle(document.documentElement);
    return [...document.querySelectorAll('coords coord')].map(c => {
      const r = c.getBoundingClientRect(), col = getComputedStyle(c).color;
      const toRgb = v => { const d = document.createElement('i'); d.style.color = v; document.body.append(d); const out = getComputedStyle(d).color; d.remove(); return out; };
      const file = c.closest('coords').classList.contains('files');
      const name = c.textContent.toLowerCase();
      // the square under the label: files sit on the bottom row, ranks on the left column
      const black = !!document.querySelector('.orientation-black');
      const fileIdx = file ? name.charCodeAt(0) - 97 : (black ? 7 : 0);
      const rankIdx = file ? (black ? 7 : 0) : Number(name) - 1;
      const dark = (fileIdx + rankIdx) % 2 === 0;
      const under = toRgb(sq.getPropertyValue(dark ? '--dark-sq' : '--light-sq'));
      return { name, inside: r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1, visible: col !== under };
    });
  });
  const bad = labels.filter(l => !l.inside || !l.visible).map(l => `${l.name}${l.inside ? '' : ' outside'}${l.visible ? '' : ' invisible'}`);
  check(who, labels.length === 16 && !bad.length, 'all 16 coordinates are on the board and readable', bad.join(', '));

  // A move, and Stockfish's answer
  await move(page, 'e2', 'e4', touch);
  await waitMoves(page, 2, 'Stockfish answering e4');
  check(who, (await page.evaluate(() => scrollY)) === 0, 'playing a move doesn’t scroll the page', `${await page.evaluate(() => scrollY)}px`);
  check(who, (await page.locator('#moves button').first().innerText()) === 'e4', 'your move is in the move list');
  check(who, (await moveCount(page)) === 2, 'Stockfish answers');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Your move.');

  // Saved in the browser: a reload carries on
  await page.reload();
  await page.locator('#board cg-board piece').first().waitFor();
  check(who, (await moveCount(page)) === 2, 'a reload keeps the game');

  // Looking back
  await page.locator('#first').click();
  check(who, /Looking at/.test(await status(page)), 'the first-move button shows the start', await status(page));
  check(who, await page.locator('#board cg-board piece').count() === 32 && await page.locator('#moves .current').count() === 0, 'with the starting position on the board');
  await page.locator('#last').click();
  check(who, (await status(page)) === 'Your move.', 'and the last-move button comes back to the game');

  // The PGN download
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
  const chunks = [];
  for await (const c of await download.createReadStream()) chunks.push(c);
  const pgn = Buffer.concat(chunks).toString();
  check(who, /^\[Event "Casual game"\]/.test(pgn) && pgn.includes('[Site "chess.pacificfish.ca"]') && /1\. e4 \S+/.test(pgn), 'Download PGN saves the game', JSON.stringify(pgn.slice(-40)));

  // Arrows and circles, with the mouse's right button
  if (mouse) {
    const a = await square(page, 'g1'), b = await square(page, 'f3');
    // Hovering a square you can move to keeps its dot (it used to swap it for a faint tint)
    await page.mouse.click(a.x, a.y, { delay: 80 });
    await page.mouse.move(b.x, b.y);
    await page.waitForTimeout(50);
    const hovered = await page.evaluate(() => { const s = document.querySelector('#board cg-board square.move-dest:hover'); return s ? getComputedStyle(s).backgroundImage : 'no hovered square'; });
    check(who, /radial-gradient/.test(hovered), 'hovering a legal square keeps its dot', hovered.slice(0, 40));
    await page.mouse.click(a.x, a.y, { delay: 80 });   // put the knight down again
    await page.waitForTimeout(50);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up({ button: 'right' });
    check(who, await page.locator('#board svg.cg-shapes line').count() === 1, 'a right-drag draws an arrow');
    // Held like a real click: chessground finds the square under the pointer once per screen
    // refresh, so a click quicker than that (as automation does by default) never lands
    await page.mouse.click(a.x, a.y, { button: 'right', delay: 80 });
    await page.waitForTimeout(50);
    check(who, await page.locator('#board svg.cg-shapes circle').count() >= 1, 'a right-click circles a square');
    await page.mouse.click(board.x + 5, board.y + 5, { delay: 80 });
    await page.waitForTimeout(50);
    check(who, await page.locator('#board svg.cg-shapes line, svg.cg-shapes circle').count() === 0, 'a click clears them');
  }

  // Take back: both your move and Stockfish's
  await page.locator('#undo').click();
  check(who, (await moveCount(page)) === 0 && (await status(page)) === 'Your move.', 'Take back undoes your move and its answer');

  // A new game as Black: the board turns round and Stockfish starts
  await page.locator('#new-game').click();
  const dlg = page.locator('#new-dialog[open]');
  await dlg.waitFor();
  await dlg.locator('input[value=b]').check();
  await dlg.locator('#level').evaluate(el => { el.value = '9'; el.dispatchEvent(new Event('input')); });
  check(who, (await dlg.locator('#level-name').innerText()) === '9: Grandmaster', 'the level slider names each level', await dlg.locator('#level-name').innerText());
  await dlg.getByRole('button', { name: 'Start' }).click();
  await waitMoves(page, 1, 'Stockfish opening as White');
  check(who, await page.locator('#board.orientation-black').count() === 1, 'playing Black turns the board round');
  check(who, /level 9, Grandmaster/.test(await page.locator('#top-player .name').innerText()), 'Stockfish is named with its level, at the top');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Your move.');
  check(who, true, 'Stockfish makes the first move');

  // Resign asks first
  await move(page, 'g8', 'f6', touch);
  await waitMoves(page, 3, 'your Nf6 in the list');
  await page.locator('#resign').click();
  await page.locator('#confirm[open]').getByRole('button', { name: 'Cancel' }).click();
  check(who, !/resigned/.test(await status(page)), 'Resign asks first, and Cancel keeps playing');
  await page.waitForFunction(() => !/thinking/.test(document.querySelector('#status').textContent));
  await page.locator('#resign').click();
  await page.locator('#confirm[open]').getByRole('button', { name: 'Resign' }).click();
  await page.waitForFunction(() => /resigned/.test(document.querySelector('#status').textContent)).catch(() => {});
  const resigned = `${await status(page)} | ${await page.locator('#moves .result').innerText().catch(() => 'no result row')}`;
  check(who, resigned === 'You resigned. Stockfish wins. | 1-0', 'resigning gives Stockfish the win', resigned);

  // The result card over the board, and Rematch: same side and level, so Stockfish opens again
  const card = page.locator('#gameover:not([hidden])');
  await card.waitFor();
  const cardText = async () => `${await card.locator('h2').innerText()} | ${await card.locator('.go-reason').innerText()} | ${await card.locator('.go-score').innerText()}`;
  check(who, (await cardText()) === 'Stockfish wins | You resigned. Level 9, 2 moves. | 1-0', 'a card over the board shows the result', await cardText());
  check(who, await card.locator('.go-card.loss').count() === 1, 'marked as a loss');
  await card.getByRole('button', { name: 'Rematch' }).click();
  await waitMoves(page, 1, 'Stockfish opening the rematch');
  check(who, await page.locator('#gameover').isHidden() && await page.locator('#board.orientation-black').count() === 1
    && /level 9/.test(await page.locator('#top-player .name').innerText()), 'Rematch starts again as Black at the same level');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Your move.');

  // Checkmate (a saved game one move from Fool's Mate, you as Black)
  await seed(page, { pgn: '1. f3 e5 2. g4 *', player: 'b', level: 1, orientation: 'black' });
  await move(page, 'd8', 'h4', touch);
  await page.waitForFunction(() => /Checkmate/.test(document.querySelector('#status').textContent));
  check(who, (await status(page)) === 'Checkmate. You win!' && (await page.locator('#moves .result').innerText()) === '0-1', 'checkmate ends the game', await status(page));
  // The board draws its highlights on the next screen refresh, so give it a moment (still fails if it never does)
  const inCheck = await page.locator('#board cg-board square.check').waitFor({ timeout: 2000 }).then(() => true, () => false);
  check(who, await page.locator('#resign').isDisabled() && inCheck && await page.locator('#board cg-board square.check').count() === 1, 'the king is shown in check and Resign is off');
  await card.waitFor();
  check(who, (await cardText()) === 'You win! | By checkmate. Level 1, 2 moves. | 0-1' && await card.locator('.go-card.win').count() === 1, 'the card shows a win', await cardText());
  await card.getByRole('button', { name: 'View the board' }).click();
  check(who, await page.locator('#gameover').isHidden() && (await status(page)) === 'Checkmate. You win!', 'View the board closes the card, and the result stays in the panel');
  await page.reload();
  await card.waitFor();
  check(who, true, 'a finished game shows its card again after a reload');
  await page.locator('#first').click();
  check(who, await page.locator('#gameover').isHidden(), 'and hides it while looking back through the moves');
  // A game saved before results recorded the winner still shows the right outcome
  await seed(page, { pgn: '1. f3 e5 2. g4 Qh4# 0-1', player: 'w', level: 3, orientation: 'white', result: { score: '0-1', text: 'Checkmate. Stockfish wins.' } });
  await card.waitFor();
  check(who, (await card.locator('h2').innerText()) === 'Stockfish wins', 'an older saved game shows the right winner', await card.locator('h2').innerText());

  // Promotion: you choose the piece (a saved position with a pawn about to promote). A rook, not a
  // knight: king and knight against a lone king can't mate, so that would end the game as a draw
  await seed(page, { pgn: '[SetUp "1"]\n[FEN "7k/P7/8/8/8/8/8/K7 w - - 0 1"]\n\n*', player: 'w', level: 1, orientation: 'white' });
  await move(page, 'a7', 'a8', touch);
  const promo = page.locator('#promotion[open]');
  await promo.waitFor();
  check(who, await promo.locator('piece.white').count() === 4, 'promoting offers four pieces in your colour');
  await promo.locator('button[data-piece=r]').click();
  await waitMoves(page, 2, 'Stockfish answering a8=R');
  check(who, (await page.locator('#moves button').first().innerText()) === 'a8=R+', 'and plays the one you pick', await page.locator('#moves button').first().innerText());
  check(who, await page.locator('#board cg-board piece.rook.white').count() === 1, 'the new rook is on the board');
  const takenText = `${await page.locator('#bottom-player .taken').innerText()} / ${await page.locator('#top-player .taken').innerText()}`;
  check(who, takenText === '+5 / ', 'you’re +5 and the promoted pawn isn’t counted as captured', JSON.stringify(takenText));
  await screenshot(page, `${SHOTS}${who}.png`);

  // The game review, on Fool's Mate (you as White, and losing): 1. f3 e5 2. g4?? Qh4#
  const rv = await freshPage();
  await rv.goto('/');
  await rv.evaluate(s => localStorage.setItem('chess.game.v1', JSON.stringify(s)), { pgn: '1. f3 e5 2. g4 Qh4# 0-1', player: 'w', level: 3, orientation: 'white', result: { score: '0-1', winner: 'b', reason: 'checkmate', text: 'Checkmate. Stockfish wins.' } });
  await rv.reload();
  await rv.locator('#gameover:not([hidden])').getByRole('button', { name: 'Review this game' }).click();
  check(who, await rv.locator('#review').isVisible() && await rv.locator('#evalbar').isVisible() && await rv.locator('.actions').isHidden(),
    'Review this game opens the review, with the evaluation bar');
  await rv.locator('#rv-progress').waitFor({ state: 'hidden', timeout: 30000 });
  // Each move as "move:rating:badge", the badge read on its own
  const ratings = await rv.locator('#moves button').evaluateAll(bs => bs.map(b => {
    const badge = b.querySelector('.badge');
    return `${b.textContent.slice(badge ? badge.textContent.length : 0)}:${b.dataset.rating}:${badge ? badge.textContent : ''}`;
  }));
  check(who, ratings.length === 4 && ratings.every(r => !/:undefined:|:$/.test(r)), 'every move gets a rating and a badge', ratings.join(' '));
  check(who, ratings[2] === 'g4:blunder:??' && ratings[3] === 'Qh4#:best:★', 'g4 is a blunder (??) and Qh4# the best move (★)', ratings.join(' '));
  await rv.locator('#moves button[data-ply="3"]').click();
  // The move's badge on the board: on g4, in the square's top-right corner
  const sqBadge = rv.locator('#board svg.cg-custom-svgs .sq-badge');
  await sqBadge.first().waitFor({ state: 'attached', timeout: 2000 }).catch(() => {});
  const g4 = await square(rv, 'g4');
  const bb = await sqBadge.first().locator('circle').boundingBox().catch(() => null);
  const size = (await rv.locator('#board cg-board').boundingBox()).width / 8;
  const inCorner = bb && bb.x > g4.x && bb.x + bb.width <= g4.x + size / 2 + 1 && bb.y >= g4.y - size / 2 - 1 && bb.y + bb.height < g4.y;
  check(who, await sqBadge.count() === 1 && await sqBadge.first().getAttribute('data-rating') === 'blunder' && inCorner,
    'the board shows a blunder badge in the corner of g4', bb ? `badge at ${Math.round(bb.x - g4.x)},${Math.round(bb.y - g4.y)} from the centre, ${Math.round(bb.width)} px` : 'no badge');
  const verdict = await rv.locator('#rv-verdict').innerText();
  check(who, /^Your g4\?\? was a blunder\.\s*Best was \S+\. Evaluation .*M1\.$/.test(verdict), 'it says what g4 was, what was best and that it allows mate', JSON.stringify(verdict));
  // The arrow is for whatever the review found best there. Not a fixed move: each position gets
  // 0.5 s, so a slower computer (GitHub's) can settle on a different, equally good one; this test
  // once insisted on e2-e4 and failed there. Drawn on the next screen refresh, like the check
  // highlight; "attached", not "visible", as a straight arrow's bounding box is 0 px wide.
  const best = await rv.evaluate(() => JSON.parse(localStorage.getItem('chess.game.v1')).review.positions[2].best);
  const arrow = await rv.locator('#board svg.cg-shapes line').first().waitFor({ state: 'attached', timeout: 2000 }).then(() => true, () => false);
  // chessground's arrows are in board units: a square's centre is at (file - 3.5, 3.5 - rank) with
  // White at the bottom, files and ranks counted from 0; the arrow runs from the start square's
  // centre towards the destination's (stopping short of it, for the head)
  const at = sq => [sq.charCodeAt(0) - 97 - 3.5, 3.5 - (Number(sq[1]) - 1)];
  const ends = arrow && await rv.locator('#board svg.cg-shapes line').first().evaluate(l => ['x1', 'y1', 'x2', 'y2'].map(a => Number(l.getAttribute(a))));
  const [ox, oy] = at(best.slice(0, 2)), [dx, dy] = at(best.slice(2, 4));
  const fromStart = ends && Math.abs(ends[0] - ox) < 0.01 && Math.abs(ends[1] - oy) < 0.01;
  const towardDest = ends && Math.abs(Math.atan2(ends[3] - ends[1], ends[2] - ends[0]) - Math.atan2(dy - oy, dx - ox)) < 0.01;
  check(who, arrow && fromStart && towardDest, `and draws an arrow for the best move (${best})`, ends ? ends.map(n => n.toFixed(2)).join(',') : 'no arrow');

  // Top lines for the position on the board: after g4, Black's best is the mate
  const lines = () => rv.locator('#rv-lines .rv-line').evaluateAll(ls => ls.map(l => ({ score: l.querySelector('.rv-score').textContent, moves: l.querySelector('.rv-pv').textContent })));
  await rv.waitForFunction(() => /depth \d+/.test(document.querySelector('#rv-lines .rv-lines-head')?.textContent || ''), null, { timeout: 15000 });
  const afterG4 = await lines();
  check(who, afterG4.length >= 1 && afterG4[0].score === '−M1' && afterG4[0].moves.startsWith('2… Qh4#'), 'the top line after g4 is Black’s mate in one', JSON.stringify(afterG4[0]));
  // Jump to g4 and straight back to the start: the lines must be for the start, never left over from g4
  await rv.locator('#moves button[data-ply="3"]').click();
  await rv.locator('#first').click();
  await rv.waitForFunction(() => /depth (1[0-9]|[5-9])\b/.test(document.querySelector('#rv-lines .rv-lines-head')?.textContent || ''), null, { timeout: 15000 });
  const atStart = await lines();
  const legalFirst = new Set(new Chess().moves());
  const firsts = atStart.map(l => l.moves.replace(/^1\.\s+/, '').split(' ')[0]);
  check(who, atStart.length === 3 && firsts.every(m => legalFirst.has(m)) && atStart.every(l => /^[+−]?\d+\.\d$|^0\.0$/.test(l.score)),
    'at the start: three lines, each beginning with a legal first move and a normal score', JSON.stringify(atStart.map(l => `${l.score} ${l.moves}`)));
  await rv.locator('#moves button[data-ply="3"]').click();
  await rv.locator('#last').click();
  const last = (await rv.locator('#rv-verdict').innerText()).replace(/\s+/g, ' ');
  check(who, last === 'Stockfish’s Qh4# was the best move. Checkmate.', 'Qh4# is described as Stockfish’s best move, and checkmate', JSON.stringify(last));
  const fill = await rv.locator('#evalbar .fill').evaluate(f => f.style.height);
  check(who, fill === '0%', 'with White mated, the bar is all Black', fill);
  const summary = await rv.locator('#rv-summary').innerText();
  check(who, /You \(white\)\s+Stockfish \(black\)/.test(summary) && /Blunder\s+1\s+0/.test(summary) && /Accuracy\s+[\d.]+\s+[\d.]+/.test(summary), 'the summary shows accuracy and counts for each side', JSON.stringify(summary.replace(/\s+/g, ' ')));
  check(who, await rv.locator('#rv-graph polygon').count() === 1 && await rv.locator('#rv-graph .mark[data-rating="blunder"]').count() === 1, 'the graph draws the game with the blunder marked');
  const wide = await rv.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(who, wide <= 0, 'the bar fits beside the board without widening the page', `${wide}px over`);
  // The review panel can be taller than the window: it must scroll, not spill over the page
  const spill = await rv.evaluate(() => {
    const p = document.querySelector('.panel'), r = p.getBoundingClientRect();
    const overflowing = p.scrollHeight > p.clientHeight + 1;
    const scrolls = ['auto', 'scroll'].includes(getComputedStyle(p).overflowY);
    const lowest = Math.max(...[...p.children].filter(c => !c.hidden).map(c => c.getBoundingClientRect().bottom));
    return overflowing && !scrolls ? `${Math.round(lowest - r.bottom)}px spills out` : '';
  });
  check(who, !spill, 'the review panel never spills out of its box', spill);
  await rv.waitForTimeout(400);   // let pieces finish sliding (0.18 s) and the bar settle (0.3 s), so the picture shows the final position
  await screenshot(rv, `${SHOTS}${who}-review.png`);
  // Saved: a reload keeps the analysis, so reviewing again is instant
  await rv.reload();
  await rv.locator('#gameover:not([hidden])').getByRole('button', { name: 'View the board' }).click();
  await rv.locator('#review-game').click();
  check(who, await rv.locator('#rv-progress').isHidden() && (await rv.locator('#moves button[data-rating]').count()) === 4, 'a reload keeps the analysis');
  await rv.locator('#rv-exit').click();
  check(who, await rv.locator('#review').isHidden() && await rv.locator('#evalbar').isHidden() && await rv.locator('.actions').isVisible(), 'Done leaves the review');
  await rv.close();

  // Accounts: a guest's game, then an account made with a secret opening (the Italian Game), the
  // game kept in it, and the account signed in to from another browser, where the game follows
  const ITALIAN = 'e2e4 e7e5 g1f3 b8c6 f1c4';
  const accText = (p, id) => p.locator(id).innerText();
  const acc = await freshPage();
  await acc.goto('/');
  await acc.locator('#board cg-board piece').first().waitFor();
  await move(acc, 'e2', 'e4', touch);
  await waitMoves(acc, 2, 'Stockfish answering a guest');
  const guestMoves = await acc.locator('#moves button').allInnerTexts();
  await acc.locator('#acc-open').click();
  await acc.locator('#account[open]').waitFor();
  await acc.locator('#account [data-tab=signup]').click();
  await acc.locator('#acc-name').fill(who);
  await playOpening(acc, ITALIAN, touch);
  check(who, (await accText(acc, '#acc-moves')) === '1. e4 e5 2. Nf3 Nc6 3. Bc4', 'the opening is shown as it’s played', await accText(acc, '#acc-moves'));
  await acc.waitForFunction(() => document.querySelector('#acc-meter p').textContent.length > 0);
  check(who, await acc.locator('#acc-meter').getAttribute('data-level') === 'weak' && /Italian/.test(await accText(acc, '#acc-meter p')),
    'the meter calls the Italian Game weak, by name', await accText(acc, '#acc-meter p'));
  await acc.locator('#acc-go').click();
  check(who, /from memory \(1 of 2\)/.test(await accText(acc, '#acc-step')) && (await accText(acc, '#acc-moves')) === '0 moves played' && await acc.locator('#acc-meter').isHidden(),
    'then it asks for it again from memory, without showing the moves');
  await playOpening(acc, 'e2e4', touch);
  check(who, (await accText(acc, '#acc-moves')) === '1 move played', 'practising counts the moves but doesn’t name them');
  await acc.locator('#acc-go').click();
  check(who, /not the same/.test(await accText(acc, '#acc-error')), 'a different opening is caught', await accText(acc, '#acc-error'));
  await playOpening(acc, ITALIAN, touch);
  await acc.locator('#acc-go').click();
  check(who, /\(2 of 2\)/.test(await accText(acc, '#acc-step')), 'the right one moves on to the second practice');
  await playOpening(acc, ITALIAN, touch);
  await acc.locator('#acc-go').click();
  await acc.locator('#account').waitFor({ state: 'hidden' });
  check(who, (await accText(acc, '#acc-who')) === who && await acc.locator('#acc-open').isHidden(), 'the account is made, and you’re signed in');
  const inAccount = await acc.evaluate(async () => (await (await fetch('/api/game')).json()).data);
  check(who, inAccount && guestMoves.every(m => inAccount.pgn.includes(m)) && inAccount.variant === 'chess', 'the guest’s game is now the account’s', inAccount && inAccount.pgn.slice(-30));
  await acc.reload();
  await acc.locator('#acc-who:not([hidden])').waitFor();
  check(who, (await accText(acc, '#acc-who')) === who, 'still signed in after a reload');

  // Another browser: a wrong opening is refused, the right one brings the game
  const other = await freshPage();
  await other.goto('/');
  await other.locator('#acc-open:not([hidden])').click();
  await other.locator('#account[open]').waitFor();
  await other.locator('#acc-name').fill(who.toLowerCase());
  await playOpening(other, 'd2d4 d7d5', touch);
  await other.locator('#acc-go').click();
  await other.waitForFunction(() => document.querySelector('#acc-error').textContent.length > 0);
  check(who, /don’t match/.test(await accText(other, '#acc-error')), 'a wrong opening doesn’t sign in', await accText(other, '#acc-error'));
  await other.locator('#acc-clear').click();
  await playOpening(other, ITALIAN, touch);
  await other.locator('#acc-go').click();
  await other.locator('#account').waitFor({ state: 'hidden' });
  await other.waitForFunction(n => document.querySelectorAll('#moves button').length === n, guestMoves.length, { timeout: 10000 }).catch(() => {});
  check(who, (await accText(other, '#acc-who')) === who && JSON.stringify(await other.locator('#moves button').allInnerTexts()) === JSON.stringify(guestMoves),
    'signed in elsewhere (any capitals), the game follows', JSON.stringify(await other.locator('#moves button').allInnerTexts()));
  // A move there reaches the account, and the first browser picks it up on its next visit
  await move(other, 'g1', 'f3', touch);
  await waitMoves(other, 4, 'Stockfish answering on the second browser');
  // Wait until the account has both full moves, asking from here in a plain loop. (Not
  // waitForFunction with an async function: its answer is a Promise, which counts as true at once,
  // so the wait ended before the second browser had sent anything.) Moves are counted below the
  // PGN's header, whose date (2026.11.06) would otherwise count too.
  const accountPlies = () => other.evaluate(async () => {
    const pgn = (await (await fetch('/api/game')).json()).data.pgn.replace(/\[[^\]]*\]\s*/g, '');
    return pgn.trim().split(/\s+/).filter(t => !/^\d+\.$|^\*$/.test(t)).length;
  });
  for (let i = 0; i < 40 && (await accountPlies()) < 4; i++) await other.waitForTimeout(300);
  await acc.reload();
  await acc.waitForFunction(() => document.querySelectorAll('#moves button').length === 4, null, { timeout: 10000 }).catch(() => {});
  check(who, (await acc.locator('#moves button').count()) === 4, 'a move on the other browser reaches the first', `${await acc.locator('#moves button').count()} moves`);
  await other.locator('#acc-out').click();
  await other.locator('#acc-open:not([hidden])').waitFor();
  check(who, await other.locator('#acc-who').isHidden() && (await other.evaluate(async () => (await (await fetch('/api/me')).json()).name)) === null, 'Sign out signs out');
  await acc.close();
  await other.close();

  // When Stockfish can't work, say so instead of "thinking" forever. Each case in a fresh browser.
  // Its loader missing: the worker reports an error straight away.
  const noLoader = await freshPage();
  await noLoader.route('**/stockfish-19-lite-single.js', r => r.fulfill({ status: 404, body: 'gone' }));
  await noLoader.goto('/');
  await noLoader.waitForFunction(() => /isn’t working/.test(document.querySelector('#status').textContent));
  check(who, (await noLoader.locator('#status').innerText()) === 'Stockfish isn’t working: its files couldn’t be loaded. Reload the page to try again.',
    'a missing engine is reported at once', await noLoader.locator('#status').innerText());
  await noLoader.close();
  // Its .wasm missing: no error at all, the engine just never answers, so the 30-second limit catches
  // it. The page's clock is moved on rather than waiting 30 real seconds.
  const silent = await freshPage();
  await silent.clock.install();
  await silent.route('**/*.wasm', r => r.fulfill({ status: 404, body: 'gone' }));
  await silent.goto('/');
  await silent.locator('#board cg-board piece').first().waitFor();
  check(who, (await silent.locator('#status').innerText()) === 'Your move.', 'a silent engine looks fine at first');
  await silent.clock.runFor(31000);
  await silent.waitForFunction(() => /isn’t working/.test(document.querySelector('#status').textContent));
  check(who, (await silent.locator('#status').innerText()) === 'Stockfish isn’t working: it didn’t start within 30 seconds. Reload the page to try again.',
    'and is reported once it misses the 30-second limit', await silent.locator('#status').innerText());
  await move(silent, 'e2', 'e4', touch);
  check(who, (await moveCount(silent)) === 0, 'after which you can’t move into a game it can’t answer');
  await silent.close();
}

// Playwright's screenshots add a <style> to the page (to hide the text cursor), which the security
// policy blocks and WebKit reports. That's the test's doing, not the site's, so reports during a
// screenshot don't count; everything else still does.
async function screenshot(page, path) {
  page.shooting = true;
  try { await page.screenshot({ path }); await page.waitForTimeout(100); } finally { page.shooting = false; }
}

async function onDevice(name) {
  const { engine, device, mouse } = DEVICES[name];
  const browser = await engine.launch();
  const context = await browser.newContext({ ...device, baseURL: BASE, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Anything the security policy blocks is a failure: the live site would break the same way
  await page.addInitScript(() => addEventListener('securitypolicyviolation', e => console.log(`CSP blocked ${e.violatedDirective}: ${e.blockedURI || 'inline'}`)));
  page.on('console', m => { if (!page.shooting && /^CSP blocked|Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => { errors.push(`browser popup: ${d.message()}`); d.dismiss(); });
  try {
    const freshPage = async () => (await browser.newContext({ ...device, baseURL: BASE })).newPage();
    await flow(page, name, { touch: !!device.hasTouch, mouse, freshPage });
    check(name, !errors.length, 'no page errors', errors.join(' | '));
  } catch (e) {
    const where = (e.stack.match(/run\.mjs:\d+/) || ['?'])[0];
    check(name, false, `stopped early at ${where}`, `${e.message.split('\n')[0]}${errors.length ? ` | page errors: ${errors.join(' | ')}` : ''}`);
    await screenshot(page, `${SHOTS}${name}-failed.png`).catch(() => {});
  }
  await browser.close();
}

const started = Date.now();
// --live (npm run test:live) tests the real chess.pacificfish.ca, and SITE_URL any other deployed
// copy, instead of serving site/ here. That's safe: everything the tests do stays in their own
// throwaway browsers; the site stores nothing.
const remote = process.env.SITE_URL || (process.argv.includes('--live') ? 'https://chess.pacificfish.ca' : null);
// Accounts need a data folder: a throwaway one, removed at the end. Plain HTTP here, so the session
// cookie can't be Secure (the real server's is).
const dataDir = remote ? null : mkdtempSync(join(tmpdir(), 'chess-browser-'));
const server = remote ? null : await start({ port: 0, host: '127.0.0.1', dataDir, secureCookies: false });
const BASE = remote ? remote.replace(/\/$/, '') : `http://127.0.0.1:${server.address().port}`;
console.log(`Testing ${BASE}`);
await Promise.all(Object.keys(DEVICES).map(onDevice));
if (server) {
  const closed = new Promise(r => server.close(r));
  server.closeAllConnections();
  await closed;
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n${passes} passed, ${fails} failed in ${Math.round((Date.now() - started) / 100) / 10}s`);
process.exit(fails ? 1 : 0);
