// Builds site/data/book.json, the opening book the secret-opening strength meter uses, from
// Lichess's openings list (github.com/lichess-org/chess-openings, CC0: free to use for anything).
// Every position along every named opening is kept, as a short hash; the positions where a named
// opening ends keep its name. Run again to update, after changing VERSION to a newer commit:
//   node tools/build-book.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { Chess } from '../site/vendor/chess.js';
import { positionHash } from '../site/js/opening.js';
import { variant } from '../site/js/variants/index.js';

const VERSION = '3ba6b20d31';   // the commit of lichess-org/chess-openings used
const tsvUrl = f => `https://raw.githubusercontent.com/lichess-org/chess-openings/${VERSION}/${f}.tsv`;
const chess = variant('chess');

const positions = new Set();
const names = new Map();   // hash -> [name, plies]: the shortest named line ending there wins
let lines = 0;
for (const f of ['a', 'b', 'c', 'd', 'e']) {
  const res = await fetch(tsvUrl(f));
  if (!res.ok) throw new Error(`${tsvUrl(f)}: ${res.status}`);
  for (const row of (await res.text()).split('\n').slice(1)) {
    if (!row.trim()) continue;
    const [, name, pgn] = row.split('\t');
    const game = new Chess();
    game.loadPgn(pgn);
    const moves = game.history({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
    const { states, error } = chess.replay(chess.start(), moves);
    if (error) throw new Error(`${name}: ${error}`);
    states.slice(1).forEach(s => positions.add(positionHash(chess.key(s))));
    const end = positionHash(chess.key(states.at(-1)));
    if (!names.has(end) || names.get(end)[1] > moves.length) names.set(end, [name, moves.length]);
    lines++;
  }
}

const out = {
  source: `github.com/lichess-org/chess-openings at ${VERSION} (CC0 1.0)`,
  built: 'tools/build-book.mjs',
  positions: [...positions].sort(),
  names: Object.fromEntries([...names].sort().map(([h, [n]]) => [h, n])),
};
mkdirSync(new URL('../site/data/', import.meta.url), { recursive: true });
const file = new URL('../site/data/book.json', import.meta.url);
writeFileSync(file, JSON.stringify(out));
console.log(`${lines} openings, ${positions.size} positions, ${names.size} named -> site/data/book.json (${Math.round(JSON.stringify(out).length / 1024)} KB)`);
