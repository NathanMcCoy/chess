// The Rust trainer (trainer/) must play exactly the rules of site/js/variants/hex.js and judge
// positions exactly as site/js/bot/bot.js does, or what it learns wouldn't fit the bot in the browser.
// Thousands of positions from random games (and some made by hand for the rare rules) go through
// both: the same position text, the same legal moves, the same position after every one of them,
// the same mate / stalemate / draw, check, and the same value by random weights.
// Needs Rust (cargo); without it the test is skipped, and says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import hex from '../site/js/variants/hex.js';
import { evaluate, startingWeights } from '../site/js/bot/bot.js';

const dir = fileURLToPath(new URL('../trainer/', import.meta.url));
const cargo = ['cargo', join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')]
  .find(c => spawnSync(c, ['--version'], { encoding: 'utf8' }).status === 0);
const e = hex.engine;

// A position from { cell: piece } (uppercase White), as in hex.test.mjs
const { files, cells } = hex.geometry;
const len = f => cells.filter(c => c.file === f).length;
const position = (pieces, turn = 'w', { ep = '-', half = 0 } = {}) => [...files].map(f => {
  let out = '', empty = 0;
  for (let rank = 1; rank <= len(f); rank++) {
    const p = pieces[f + rank];
    if (!p) { empty++; continue; }
    if (empty) { out += empty; empty = 0; }
    out += p;
  }
  return out + (empty || '');
}).join('/') + ` ${turn} ${ep} ${half} 1`;

test('the Rust trainer plays the same rules and judges the same as the site', { skip: !cargo && 'Rust (cargo) is not installed' }, () => {
  const built = spawnSync(cargo, ['build', '--release', '--quiet'], { cwd: dir, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const bin = join(dir, 'target', 'release', process.platform === 'win32' ? 'trainer.exe' : 'trainer');
  assert.ok(existsSync(bin));

  // Positions: random games (seeded, so every run checks the same ones), and the rare rules by hand
  const states = [];
  let x = 20261108;
  const rand = n => { x = (x * 48271) % 2147483647; return x % n; };
  for (let g = 0; g < 120; g++) {
    let pos = e.from(hex.start());
    for (let ply = 0; ply < 90; ply++) {
      states.push(e.state(pos));
      const list = e.moves(pos);
      if (!list.length || e.drawn(pos)) break;
      // Prefer pawn moves now and then, so pawns reach the end and promote
      const pawns = list.filter(m => (pos.board[m.from] || '').toUpperCase() === 'P');
      const pick = pawns.length && rand(3) === 0 ? pawns : list;
      pos = e.play(pos, pick[rand(pick.length)]);
    }
  }
  states.push(
    hex.replay(position({ a6: 'k', a1: 'K', b4: 'Q' }), ['b4c6']).states[1],   // checkmate
    hex.replay(position({ a6: 'k', a2: 'K', d7: 'Q' }), ['a2b4']).states[1],   // stalemate
    position({ a6: 'k', a1: 'K', c3: 'N' }),                                     // too few pieces
    position({ a6: 'k', a1: 'K', c3: 'R' }, 'w', { half: 100 }),                 // fifty moves
    position({ a6: 'k', a1: 'K', f10: 'P', g4: 'p' }),                           // a promotion
  );

  // Random weights: whatever training makes of them, both must agree
  const w = startingWeights('hex', e.cells);
  let y = 7;
  w.values = w.values.map(() => { y = (y * 16807) % 2147483647; return Math.round(((y / 2147483647) * 4 - 2) * 1e4) / 1e4; });
  const tmp = mkdtempSync(join(tmpdir(), 'trainer-check-'));
  const file = join(tmp, 'w.json');
  writeFileSync(file, JSON.stringify(w));
  const run = spawnSync(bin, ['check', '--weights', file], { input: states.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 30 });
  rmSync(tmp, { recursive: true, force: true });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, states.length);

  const seen = { ep: 0, promotion: 0, check: 0, mate: 0, stalemate: 0, drawn: 0 };
  lines.forEach((line, k) => {
    const [state, moves, status, check, value, children] = line.replace(/\r$/, '').split('\t');
    const pos = e.from(states[k]);
    const where = `position ${k}: ${states[k]}`;
    assert.equal(state, e.state(pos), `${where}: the text`);
    const list = e.moves(pos).map(m => [e.text(m), m]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    assert.equal(moves, list.map(m => m[0]).join(' '), `${where}: the legal moves`);
    const jsStatus = !list.length ? (e.noMoves(pos).winner ? 'mate' : 'stalemate') : e.drawn(pos) ? 'drawn' : '-';
    assert.equal(status, jsStatus, `${where}: how it stands`);
    assert.equal(check, String(e.inCheck(pos)), `${where}: check`);
    assert.ok(Math.abs(Number(value) - evaluate(e, pos, w)) < 1e-9, `${where}: value ${value} against ${evaluate(e, pos, w)}`);
    const after = children ? children.split('|') : [];
    list.forEach(([text, m], i) => assert.equal(after[i], e.state(e.play(pos, m)), `${where}: after ${text}`));
    if (pos.ep >= 0) seen.ep++;
    if (list.some(([t]) => /[qrbn]$/.test(t))) seen.promotion++;
    if (check === 'true') seen.check++;
    if (status in seen) seen[status]++;
  });
  // The random games must really have reached the rare rules, or the test proves less than it says
  assert.ok(seen.ep >= 50 && seen.promotion >= 20 && seen.check >= 50 && seen.mate >= 1 && seen.stalemate >= 1 && seen.drawn >= 2,
    `too few rare positions checked: ${JSON.stringify(seen)}`);
});
