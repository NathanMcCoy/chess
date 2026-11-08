// The neural network judges positions in Rust (trainer/src/nn.rs, and later the browser's WebAssembly),
// but is trained in PyTorch (nn/train.py). If the two read a position differently (which piece is
// which input, Black's cells mirrored, the layers' order), the bot would play with a network it
// doesn't understand. `trainer nn-check` compares them on the positions train.py saved with what
// PyTorch made of them, and also checks the first layer kept up move by move (as the search does)
// against working it out afresh, along random games with captures, en passant and promotions.
//
// 1. A tiny network saved in tests/data/nn-small.json (always run: CI has no PyTorch). Made with
//      trainer gen-data --games 200 --nodes 300 --seed 5 --out small.bin
//      python nn/train.py small.bin --acc 8 --hidden 4 --epochs 2 --out tests/data/nn-small.json
// 2. Where PyTorch is installed (NN_PYTHON, or this PC's venv): a fresh one trained by today's
//    train.py, so a change to train.py that the saved network can't show is caught too.
// Needs Rust (cargo); without it the test is skipped, and says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = join(root, 'trainer');
const cargo = ['cargo', join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')]
  .find(c => spawnSync(c, ['--version'], { encoding: 'utf8' }).status === 0);
const python = [process.env.NN_PYTHON, 'D:/TRUENAS/CLAUDE/nn-venv/Scripts/python.exe'].filter(Boolean)
  .find(p => spawnSync(p, ['-c', 'import torch'], { encoding: 'utf8' }).status === 0);
const TOLERANCE = 0.0001;   // pawns: float sums in another order differ by about 0.00001

let bin;
function trainer(...args) {
  if (!bin) {
    const built = spawnSync(cargo, ['build', '--release', '--quiet'], { cwd: dir, encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    bin = join(dir, 'target', 'release', process.platform === 'win32' ? 'trainer.exe' : 'trainer');
    assert.ok(existsSync(bin));
  }
  const r = spawnSync(bin, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function check(net) {
  const out = trainer('nn-check', '--net', net);
  const pytorch = out.match(/(\d+) positions: the largest difference from PyTorch is ([\d.]+) pawns/);
  assert.ok(pytorch, out);
  assert.equal(Number(pytorch[1]), 200, 'positions PyTorch saved');
  assert.ok(Number(pytorch[2]) <= TOLERANCE, `Rust and PyTorch differ by ${pytorch[2]} pawns`);
  const moves = out.match(/(\d+) positions along random games \((\d+) captures, (\d+) en passant, (\d+) promotions\): .* at most ([\d.]+) pawns apart/);
  assert.ok(moves, out);
  const [, positions, captures, ep, promos, worst] = moves.map(Number);
  assert.ok(positions > 10000 && captures > 0 && ep > 0 && promos > 0, `the random games met too few rare moves: ${moves[0]}`);
  assert.ok(worst <= TOLERANCE, `the first layer kept up move by move is ${worst} pawns from afresh`);
}

test('Rust judges like PyTorch: the saved tiny network', { skip: !cargo && 'Rust (cargo) is not installed' }, () => {
  check(join(root, 'tests', 'data', 'nn-small.json'));
});

test('Rust judges like PyTorch: a network trained now by nn/train.py', {
  skip: (!cargo && 'Rust (cargo) is not installed') || (!python && 'PyTorch is not installed (set NN_PYTHON)'),
}, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nn-test-'));
  try {
    const data = join(tmp, 'small.bin'), net = join(tmp, 'net.json');
    trainer('gen-data', '--games', '60', '--nodes', '200', '--threads', '2', '--seed', '9', '--out', data);
    const r = spawnSync(python, [join(root, 'nn', 'train.py'), data, '--acc', '8', '--hidden', '4', '--epochs', '1', '--out', net],
      { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    check(net);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
