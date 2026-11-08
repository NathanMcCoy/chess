// The port of Felipe Lecot's Hex Chess Engine (trainer/src/felipe.rs) must choose as the original
// does. tests/data/felipe-original.json holds the original's answers (move and score on 200
// positions, at depth 1, where the score is nearly its judgement itself, and at depth 3; each depth
// one run), recorded from the C program built from its source. The port must give the same, the
// positions in the same order (its table of positions carries over between them, as the original's
// does). Needs Rust (cargo); without it the test is skipped, and says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../trainer/', import.meta.url));
const cargo = ['cargo', join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')]
  .find(c => spawnSync(c, ['--version'], { encoding: 'utf8' }).status === 0);
const original = JSON.parse(readFileSync(new URL('./data/felipe-original.json', import.meta.url), 'utf8'));

test('the port of Felipe Lecot\'s engine chooses as the original does', { skip: !cargo && 'Rust (cargo) is not installed' }, () => {
  const built = spawnSync(cargo, ['build', '--release', '--quiet'], { cwd: dir, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const bin = join(dir, 'target', 'release', process.platform === 'win32' ? 'trainer.exe' : 'trainer');
  for (const { depth, answers } of original.runs) {
    const run = spawnSync(bin, ['felipe-check', '--depth', String(depth)], { input: original.states.join('\n') + '\n', encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const ported = run.stdout.trim().split('\n').map(l => l.trim().split(' '));
    assert.equal(ported.length, original.states.length);
    answers.forEach(([move, score], k) => {
      assert.equal(`${ported[k][0]} ${ported[k][1]}`, `${move} ${score}`, `depth ${depth}, position ${k}: ${original.states[k]}`);
    });
  }
});
