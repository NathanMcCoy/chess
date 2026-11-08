// The neural network's improvement loop. Each round:
//   1. the best network so far plays itself (trainer gen-data --net): new positions, labelled by
//      its own search
//   2. a new network learns from all the positions so far (nn/train.py)
//   3. it plays the best (trainer net-match --vs-net), and takes its place only if it wins by
//      twice the match's margin of error
//
//   node nn/loop.mjs --rounds 3 --best D:/TRUENAS/CLAUDE/nn-data/net5-h16.json
// Options: --games (40000 a round), --nodes (2000 positions a move), --match (400), --hidden (16),
// --dir (D:/TRUENAS/CLAUDE/nn-data/loop), --data (data files to start from, comma-separated:
// D:/TRUENAS/CLAUDE/nn-data/gen5-5k.bin,D:/TRUENAS/CLAUDE/nn-data/gen5-2k.bin). Writes a log there.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const repo = fileURLToPath(new URL('..', import.meta.url));
const trainer = join(repo, 'trainer', 'target', 'release', process.platform === 'win32' ? 'trainer.exe' : 'trainer');
const python = arg('python', 'D:/TRUENAS/CLAUDE/nn-venv/Scripts/python.exe');
const dir = arg('dir', 'D:/TRUENAS/CLAUDE/nn-data/loop');
const rounds = Number(arg('rounds', 3)), games = arg('games', '40000'), nodes = arg('nodes', '2000'), match = arg('match', '400'), hidden = arg('hidden', '16');
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

const done = readdirSync(dir).filter(f => /^round-\d+\.bin$/.test(f)).length;   // carry on from earlier rounds
log(`starting from ${best}, after ${done} earlier rounds`);
for (let round = done + 1; round <= done + rounds; round++) {
  const t = Date.now();
  const data = join(dir, `round-${round}.bin`);
  run(trainer, ['gen-data', '--net', best, '--games', games, '--nodes', nodes, '--seed', String(100 + round), '--out', data]);
  const all = [...startData, ...readdirSync(dir).filter(f => /^round-\d+\.bin$/.test(f)).map(f => join(dir, f))].filter(existsSync);
  const net = join(dir, `net-${round}.json`);
  const trained = run(python, ['nn/train.py', ...all, '--epochs', '8', '--hidden', hidden, '--out', net]);
  const kept = (trained.match(/on the kept-back positions ([\d.]+)/g) || []).pop();
  const check = run(trainer, ['nn-check', '--net', net]).trim().split('\n');
  const m = run(trainer, ['net-match', '--net', net, '--vs-net', best, '--nodes', nodes, '--match', match]);
  const [, score, sd] = m.match(/: ([\d.]+)% ± ([\d.]+)/);
  const better = Number(score) - 2 * Number(sd) > 50;
  log(`round ${round}: ${all.length} data files; ${kept}; ${check.map(l => l.replace(/^\d+ positions(?: along random games \([^)]*\))?: /, '')).join('; ')}`);
  log(`round ${round}: new against best ${score}% ± ${sd}: ${better ? 'kept' : 'not kept'} (${Math.round((Date.now() - t) / 1000)} s)`);
  if (better) best = net;
}
log(`best: ${best}`);
