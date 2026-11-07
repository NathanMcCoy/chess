// The secret-opening strength meter (site/js/opening.js) against the real book, no browser
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { positionHash, loadBook, openingStrength } from '../site/js/opening.js';

const json = JSON.parse(readFileSync(new URL('../site/data/book.json', import.meta.url)));
const book = loadBook(json);
const strength = moves => openingStrength(moves.split(' ').filter(Boolean), book);

test('the hash is standard FNV-1a', () => {
  // published test values for 32-bit FNV-1a
  assert.equal(positionHash(''), '811c9dc5');
  assert.equal(positionHash('a'), 'e40c292c');
  assert.equal(positionHash('foobar'), 'bf9cf968');
});

test('the book is built and credited', () => {
  assert.ok(json.positions.length > 5000, `${json.positions.length} positions`);
  assert.ok(Object.keys(json.names).length > 3000);
  assert.match(json.source, /lichess-org\/chess-openings at [0-9a-f]+ \(CC0/);
  assert.ok(Object.values(json.names).every(n => typeof n === 'string' && n.length > 2));
});

test('no moves yet', () => {
  assert.equal(strength('').level, 'none');
});

test('one or two moves are weak, whatever they are', () => {
  assert.equal(strength('e2e4').level, 'weak');
  assert.match(strength('e2e4').message, /^Only 1 move:/);
  assert.equal(strength('h2h4 a7a5').level, 'weak');
});

test('a famous opening is weak, and named', () => {
  const s = strength('e2e4 e7e5 g1f3 b8c6 f1c4');
  assert.equal(s.level, 'weak');
  assert.equal(s.inBook, 5);
  assert.match(s.name, /Italian/);
  assert.match(s.message, /straight from the opening books \(Italian/);
});

test('a long book line is only fair', () => {
  const s = strength('e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6');   // Ruy Lopez, Morphy Defence
  assert.equal(s.inBook, 8);
  assert.equal(s.level, 'fair');
  assert.match(s.name, /Ruy Lopez/);
});

test('leaving the books early and going on is strong', () => {
  // 1. Nh3 a5 2. Ng1 Ra6 3. Nh3 Rh6: off the books by the second move
  const s = strength('g1h3 a7a5 h3g1 a8a6 g1h3 a6h6');
  assert.ok(s.inBook <= 2, `in the books for ${s.inBook}`);
  assert.equal(s.level, 'strong');
  assert.match(s.message, /hard to guess/);
});

test('it follows transpositions: the position counts, not the order', () => {
  const a = strength('g1f3 g8f6 d2d4'), b = strength('d2d4 g8f6 g1f3');
  assert.equal(a.inBook, 3);
  assert.equal(b.inBook, 3);
});
