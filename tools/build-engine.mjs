// Builds the Rust engine (trainer/src/lib.rs: rules, search, judgement) to WebAssembly for the
// browser's bot, as site/js/bot/hex-engine.wasm. Run it after changing trainer/src/lib.rs, hex.rs,
// search.rs or wasm.rs: tests/wasm.test.mjs fails if the file wasn't built from the source as it is.
//   node tools/build-engine.mjs
// Needs Rust with its WebAssembly target: rustup target add wasm32-unknown-unknown
import { spawnSync } from 'node:child_process';
import { copyFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../trainer/', import.meta.url));
const cargo = ['cargo', join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')]
  .find(c => spawnSync(c, ['--version'], { encoding: 'utf8' }).status === 0);
if (!cargo) throw new Error('Rust (cargo) is not installed');
const built = spawnSync(cargo, ['build', '--release', '--lib', '--target', 'wasm32-unknown-unknown'], { cwd: dir, stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
const to = fileURLToPath(new URL('../site/js/bot/hex-engine.wasm', import.meta.url));
copyFileSync(join(dir, 'target', 'wasm32-unknown-unknown', 'release', 'engine.wasm'), to);
console.log(`Wrote site/js/bot/hex-engine.wasm (${(statSync(to).size / 1024).toFixed(0)} KB)`);
