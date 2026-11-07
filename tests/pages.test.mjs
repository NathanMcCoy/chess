// The pages' own HTML, no browser
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = path => readFileSync(new URL(`../site/${path}`, import.meta.url), 'utf8');
const box = (html, id) => {
  const m = html.match(new RegExp(`<dialog id="${id}"[\\s\\S]*?</dialog>`));
  assert.ok(m, `no #${id}`);
  return m[0];
};

test('the hex page’s Play a friend and Live games boxes are the chess page’s, unchanged', () => {
  // online.js drives both pages' copies, so they mustn't drift apart
  const chess = page('index.html'), hex = page('hex/index.html');
  for (const id of ['friend-dialog', 'lobby', 'confirm']) assert.equal(box(hex, id), box(chess, id), id);
});
