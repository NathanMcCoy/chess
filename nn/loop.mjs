// The neural network's improvement loop. Each round:
//   1. the best network so far plays itself (trainer gen-data --net): new positions, labelled by
//      its own search
//   2. a new network learns from all the positions so far (nn/train.py)
//   3. it plays the best (trainer net-match --vs-net), and takes its place only if it wins by
//      twice the match's margin of error
//
//   node nn/loop.mjs --rounds 3 --best D:/TRUENAS/CLAUDE/nn-data/net5-h16.json
// Options: --games (40000 a round), --nodes (2000 positions a move), --match (400), --hidden (16),
// --acc (128: the first layer's width), --epochs (8), --random (0.05: gen-data's chance of a random
// move early on, for variety), --dir (D:/TRUENAS/CLAUDE/nn-data/loop), --data (data files to start
// from, comma-separated: D:/TRUENAS/CLAUDE/nn-data/gen5-5k.bin,D:/TRUENAS/CLAUDE/nn-data/gen5-2k.bin),
// --rounds (3), --train-only (no new games this round: learn from the data there is, e.g. to try a
// bigger network). Writes a log there.
// When the new network is a different size from the best, the match is at equal time, not equal
// positions: each side gets positions in proportion to its speed (trainer bench --suite), as a
// bigger network searches fewer positions in the browser's time.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const repo = fileURLToPath(new URL('..', import.meta.url));
const trainer = join(repo, 'trainer', 'target', 'release', process.platform === 'win32' ? 'trainer.exe' : 'trainer');
const python = arg('python', 'D:/TRUENAS/CLAUDE/nn-venv/Scripts/python.exe');
const dir = arg('dir', 'D:/TRUENAS/CLAUDE/nn-data/loop');
const rounds = Number(arg('rounds', 3)), games = arg('games', '40000'), nodes = arg('nodes', '2000'), match = arg('match', '400'), hidden = arg('hidden', '16');
const acc = arg('acc', '128'), epochs = arg('epochs', '8'), random = arg('random', '0.05');
const trainOnly = process.argv.includes('--train-only');
const startData = arg('data', 'D:/TRUENAS/CLAUDE/nn-data/gen5-5k.bin,D:/TRUENAS/CLAUDE/nn-data/gen5-2k.bin').split(',');
let best = arg('best');
if (!best) throw new Error('--best <network.json>: the network to start from');
mkdirSync(dir, { recursive: true });
const log = line => { console.log(line); appendFileSync(join(dir, 'loop.log'), `${new Date().toISOString()} ${line}\n`); };

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout;
}

// A network's size, from its file (acc and hidden are near the start; no need to read 3 MB)
const sizeOf = file => {
  const head = readFileSync(file, 'utf8').slice(0, 4000);
  return `${head.match(/"acc": ?(\d+)/)?.[1]}/${head.match(/"hidden": ?(\d+)/)?.[1] ?? 32}`;
};
// Positions a second searching with a network (trainer bench --suite)
const speedOf = file => Number(run(trainer, ['bench', '--net', file, '--nodes', '1', '--suite', '300000']).match(/\((\d+)\/s\)/)[1]);

const done = readdirSync(dir).filter(f => /^round-\d+\.bin$/.test(f)).length;   // carry on from earlier rounds
const doneNets = readdirSync(dir).filter(f => /^net-\d+\.json$/.test(f)).length;
log(`starting from ${best} (${sizeOf(best)}), after ${done} rounds of games; settings: games ${games}, nodes ${nodes}, random ${random}, acc ${acc}, hidden ${hidden}, epochs ${epochs}${trainOnly ? ', training only' : ''}`);
for (let k = 1; k <= rounds; k++) {
  const t = Date.now();
  const round = Math.max(done, doneNets) + k;
  if (!trainOnly) {
    const data = join(dir, `round-${round}.bin`);
    run(trainer, ['gen-data', '--net', best, '--games', games, '--nodes', nodes, '--random', random, '--seed', String(100 + round), '--out', data]);
  }
  const all = [...startData, ...readdirSync(dir).filter(f => /^round-\d+\.bin$/.test(f)).map(f => join(dir, f))].filter(existsSync);
  const net = join(dir, `net-${round}.json`);
  const trained = run(python, ['nn/train.py', ...all, '--epochs', epochs, '--acc', acc, '--hidden', hidden, '--out', net]);
  const kept = (trained.match(/on the kept-back positions ([\d.]+)/g) || []).pop();
  const check = run(trainer, ['nn-check', '--net', net]).trim().split('\n');
  // Equal positions for networks of one size; equal time for different sizes
  let nodesNew = Number(nodes), nodesBest = Number(nodes), how = 'equal positions';
  if (sizeOf(net) !== sizeOf(best)) {
    const [sn, sb] = [speedOf(net), speedOf(best)];
    nodesNew = Math.round(Number(nodes) * Math.min(1, sn / sb));
    nodesBest = Math.round(Number(nodes) * Math.min(1, sb / sn));
    how = `equal time: ${sizeOf(net)} ${sn}/s with ${nodesNew}, ${sizeOf(best)} ${sb}/s with ${nodesBest}`;
  }
  const m = run(trainer, ['net-match', '--net', net, '--vs-net', best, '--nodes', String(nodesNew), '--nodes-b', String(nodesBest), '--match', match]);
  const [, score, sd] = m.match(/: ([\d.]+)% ± ([\d.]+)/);
  const better = Number(score) - 2 * Number(sd) > 50;
  log(`round ${round}: ${all.length} data files; ${kept}; ${check.map(l => l.replace(/^\d+ positions(?: along random games \([^)]*\))?: /, '')).join('; ')}`);
  log(`round ${round}: new (${sizeOf(net)}) against best ${score}% ± ${sd} (${how}): ${better ? 'kept' : 'not kept'} (${Math.round((Date.now() - t) / 1000)} s)`);
  if (better) best = net;
}
log(`best: ${best}`);
