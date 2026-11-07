// The site in real browsers, on phone and desktop screens, all at once: `npm test`.
// iPhone runs in WebKit (Safari's engine), Android and Desktop in Chromium. Each device is its own
// browser with its own saved game, so they can't affect each other. A failure names the device and
// the test line, and saves a screenshot as tests/shots/<device>-failed.png.
import { chromium, webkit, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from './server.mjs';

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
async function square(page, sq) {
  // Back to the top first, as a player would: clicking buttons lower down scrolls the page, and a
  // reload keeps that scroll position
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = await page.locator('cg-board').boundingBox();
  const black = await page.locator('.cg-wrap.orientation-black').count();
  const f = sq.charCodeAt(0) - 97, r = Number(sq[1]) - 1, size = box.width / 8;
  const col = black ? 7 - f : f, row = black ? r : 7 - r;
  return { x: box.x + (col + 0.5) * size, y: box.y + (row + 0.5) * size };
}
async function tap(page, sq, touch) {
  const { x, y } = await square(page, sq);
  if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
}
async function move(page, from, to, touch) { await tap(page, from, touch); await tap(page, to, touch); }
const moveCount = page => page.locator('#moves button').count();
const waitMoves = (page, n, why) => page.waitForFunction(n => document.querySelectorAll('#moves button').length === n, n, { timeout: 15000 })
  .catch(async () => { throw new Error(`waiting for ${n} moves (${why}); the list has ${await moveCount(page)}, status: ${await status(page)}`); });
const status = page => page.locator('#status').innerText();
async function seed(page, saved) {
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [SAVE, saved]);
  await page.reload();
  await page.locator('cg-board piece').first().waitFor();
}

async function flow(page, who, { touch, mouse }) {
  await page.goto('/');
  await page.locator('cg-board piece').first().waitFor();
  check(who, await page.locator('cg-board piece').count() === 32, 'the board starts with 32 pieces');
  check(who, (await status(page)) === 'Your move.', 'and says it is your move', await status(page));
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(who, over <= 0, 'nothing is wider than the screen', `${over}px over`);
  const board = await page.locator('cg-board').boundingBox();
  check(who, Math.abs(board.width - board.height) < 2 && board.width >= 300, 'the board is square and big enough', `${Math.round(board.width)}×${Math.round(board.height)}`);
  // Every coordinate label is inside the board and not the colour of the square it sits on
  const labels = await page.evaluate(() => {
    const b = document.querySelector('cg-board').getBoundingClientRect();
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
  await page.locator('cg-board piece').first().waitFor();
  check(who, (await moveCount(page)) === 2, 'a reload keeps the game');

  // Looking back
  await page.locator('#first').click();
  check(who, /Looking at/.test(await status(page)), 'the first-move button shows the start', await status(page));
  check(who, await page.locator('cg-board piece').count() === 32 && await page.locator('#moves .current').count() === 0, 'with the starting position on the board');
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
    const hovered = await page.evaluate(() => { const s = document.querySelector('cg-board square.move-dest:hover'); return s ? getComputedStyle(s).backgroundImage : 'no hovered square'; });
    check(who, /radial-gradient/.test(hovered), 'hovering a legal square keeps its dot', hovered.slice(0, 40));
    await page.mouse.click(a.x, a.y, { delay: 80 });   // put the knight down again
    await page.waitForTimeout(50);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up({ button: 'right' });
    check(who, await page.locator('svg.cg-shapes line').count() === 1, 'a right-drag draws an arrow');
    // Held like a real click: chessground finds the square under the pointer once per screen
    // refresh, so a click quicker than that (as automation does by default) never lands
    await page.mouse.click(a.x, a.y, { button: 'right', delay: 80 });
    await page.waitForTimeout(50);
    check(who, await page.locator('svg.cg-shapes circle').count() >= 1, 'a right-click circles a square');
    await page.mouse.click(board.x + 5, board.y + 5, { delay: 80 });
    await page.waitForTimeout(50);
    check(who, await page.locator('svg.cg-shapes line, svg.cg-shapes circle').count() === 0, 'a click clears them');
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
  check(who, await page.locator('.cg-wrap.orientation-black').count() === 1, 'playing Black turns the board round');
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
  check(who, await page.locator('#gameover').isHidden() && await page.locator('.cg-wrap.orientation-black').count() === 1
    && /level 9/.test(await page.locator('#top-player .name').innerText()), 'Rematch starts again as Black at the same level');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Your move.');

  // Checkmate (a saved game one move from Fool's Mate, you as Black)
  await seed(page, { pgn: '1. f3 e5 2. g4 *', player: 'b', level: 1, orientation: 'black' });
  await move(page, 'd8', 'h4', touch);
  await page.waitForFunction(() => /Checkmate/.test(document.querySelector('#status').textContent));
  check(who, (await status(page)) === 'Checkmate. You win!' && (await page.locator('#moves .result').innerText()) === '0-1', 'checkmate ends the game', await status(page));
  // The board draws its highlights on the next screen refresh, so give it a moment (still fails if it never does)
  const inCheck = await page.locator('cg-board square.check').waitFor({ timeout: 2000 }).then(() => true, () => false);
  check(who, await page.locator('#resign').isDisabled() && inCheck && await page.locator('cg-board square.check').count() === 1, 'the king is shown in check and Resign is off');
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
  check(who, await page.locator('cg-board piece.rook.white').count() === 1, 'the new rook is on the board');
  const takenText = `${await page.locator('#bottom-player .taken').innerText()} / ${await page.locator('#top-player .taken').innerText()}`;
  check(who, takenText === '+5 / ', 'you’re +5 and the promoted pawn isn’t counted as captured', JSON.stringify(takenText));
  await screenshot(page, `${SHOTS}${who}.png`);
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
    await flow(page, name, { touch: !!device.hasTouch, mouse });
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
const server = remote ? null : await serve();
const BASE = remote ? remote.replace(/\/$/, '') : `http://127.0.0.1:${server.address().port}`;
console.log(`Testing ${BASE}`);
await Promise.all(Object.keys(DEVICES).map(onDevice));
server?.close();
console.log(`\n${passes} passed, ${fails} failed in ${Math.round((Date.now() - started) / 100) / 10}s`);
process.exit(fails ? 1 : 0);
