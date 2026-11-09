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
// bigger network), --warm (start each network from the best when it's the same size: --warm-epochs
// passes (4) at --warm-lr (0.0005)), --patience (2: stop a training when the kept-back error hasn't
// improved for this many passes, keeping the best), --no-overlap (make each round's games only after
// the last round's match). Writes a log there.
// By default the next round's games are made while this round's network trains and plays (the GPU
// and the CPU busy at once), by the best network so far.
// When the new network is a different size from the best, the match is at equal time, not equal
// positions: each side gets positions in proportion to its speed (trainer bench --suite), as a
// bigger network searches fewer positions in the browser's time.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
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
const warm = process.argv.includes('--warm'), warmEpochs = arg('warm-epochs', '4'), warmLr = arg('warm-lr', '0.0005'), patience = arg('patience', '2');
const overlap = !process.argv.includes('--no-overlap');
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

// The games for a round, in the background: written to round-N.bin.part and renamed when complete,
// so a run stopped part-way never leaves a half-written file that counts as a round
function gen(round, net) {
  const part = join(dir, `round-${round}.bin.part`), done = join(dir, `round-${round}.bin`);
  return new Promise((resolve, reject) => {
    const child = spawn(trainer, ['gen-data', '--net', net, '--games', games, '--nodes', nodes, '--random', random, '--seed', String(100 + round), '--out', part],
      { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) return reject(new Error(`gen-data for round ${round} failed:\n${err}`));
      renameSync(part, done);
      resolve();
    });
  });
}

for (const f of readdirSync(dir)) if (f.endsWith('.part')) rmSync(join(dir, f));   // left by a run stopped part-way
const done = readdirSync(dir).filter(f => /^round-\d+\.bin$/.test(f)).length;   // carry on from earlier rounds
const doneNets = readdirSync(dir).filter(f => /^net-\d+\.json$/.test(f)).length;
const size = `${acc}/${hidden}`;
log(`starting from ${best} (${sizeOf(best)}), after ${done} rounds of games; settings: games ${games}, nodes ${nodes}, random ${random}, acc ${acc}, hidden ${hidden}, epochs ${epochs}, patience ${patience}${warm ? `, warm (${warmEpochs} passes, lr ${warmLr})` : ''}${trainOnly ? ', training only' : ''}${overlap ? ', overlapped' : ''}`);
let next = null;   // the next round's games, being made meanwhile: { round, by, promise }
for (let k = 1; k <= rounds; k++) {
  const t = Date.now();
  const round = Math.max(done, doneNets) + k;
  let madeBy = null, meanwhile = false;
  if (!trainOnly) {
    meanwhile = !!next && next.round === round;
    if (meanwhile) await next.promise; else await gen(round, best);
    madeBy = meanwhile ? next.by : best;
    next = null;
    // Overlap: the next round's games start now, by the best network so far, while this round's
    // network trains and plays (GPU, then CPU). Not when sizes differ: the equal-time match measures
    // speed, which a busy CPU would skew. If this round's network is kept, the next round's games
    // were made by the one before it: still good games, and said in the log.
    if (overlap && k < rounds && sizeOf(best) === size) {
      const promise = gen(round + 1, best);
      promise.catch(() => {});   // seen when awaited
      next = { round: round + 1, by: best, promise };
    }
  }
  const all = [...startData, ...readdirSync(dir).filter(f => /^round-\d+\.bin$/.test(f)).map(f => join(dir, f))].filter(existsSync);
  const net = join(dir, `net-${round}.json`);
  // Warm: from the best network when it's this size, a few passes at a lower rate; else afresh
  const fromBest = warm && sizeOf(best) === size;
  const how = fromBest ? ['--init', best, '--epochs', warmEpochs, '--lr', warmLr] : ['--epochs', epochs];
  const trained = run(python, ['nn/train.py', ...all, ...how, '--patience', patience, '--acc', acc, '--hidden', hidden, '--out', net]);
  const kept = (trained.match(/on the kept-back positions ([\d.]+)/g) || []).pop();
  const passes = (trained.match(/epoch \d+:/g) || []).length;
  const check = run(trainer, ['nn-check', '--net', net]).trim().split('\n');
  // Equal positions for networks of one size; equal time for different sizes
  let nodesNew = Number(nodes), nodesBest = Number(nodes), fair = 'equal positions';
  if (sizeOf(net) !== sizeOf(best)) {
    const [sn, sb] = [speedOf(net), speedOf(best)];
    nodesNew = Math.round(Number(nodes) * Math.min(1, sn / sb));
    nodesBest = Math.round(Number(nodes) * Math.min(1, sb / sn));
    fair = `equal time: ${sizeOf(net)} ${sn}/s with ${nodesNew}, ${sizeOf(best)} ${sb}/s with ${nodesBest}`;
  }
  const m = run(trainer, ['net-match', '--net', net, '--vs-net', best, '--nodes', String(nodesNew), '--nodes-b', String(nodesBest), '--match', match]);
  const [, score, sd] = m.match(/: ([\d.]+)% ± ([\d.]+)/);
  const better = Number(score) - 2 * Number(sd) > 50;
  log(`round ${round}: ${madeBy ? `games by ${madeBy}${meanwhile ? ' (made during the last round)' : ''}; ` : ''}${all.length} data files; ${fromBest ? 'warm, ' : ''}${passes} passes; ${kept}; ${check.map(l => l.replace(/^\d+ positions(?: along random games \([^)]*\))?: /, '')).join('; ')}`);
  log(`round ${round}: new (${sizeOf(net)}) against best ${score}% ± ${sd} (${fair}): ${better ? 'kept' : 'not kept'} (${Math.round((Date.now() - t) / 1000)} s)`);
  if (better) best = net;
}
log(`best: ${best}`);