// A network from nn/train.py (JSON, ~3 MB) as the small binary file the browser's bot loads
// (site/js/bot/worker.js -> wasm.js setNet -> trainer/src/wasm.rs set_net):
//   node tools/build-net.mjs D:/TRUENAS/CLAUDE/nn-data/loop/net-3.json   (-> site/data/bot/hex-net.bin)
//   node tools/build-net.mjs <net.json> <out.bin>
// The file: "HXNN", then 3 little-endian u32s (version 1, acc, hidden), then every number as a
// little-endian f32, in trainer/src/nn.rs's order (as train.rs load_net reads the JSON):
// l1 w, b; l2 w, b; l3 w, b; l4 w, b; the shortcut (psqt; nothing in the file = zeros).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const INPUTS = 2 * 6 * 91;

export function netBytes(net) {
  const { acc, hidden: h = 32 } = net;
  const parts = [];
  for (const layer of ['l1', 'l2', 'l3', 'l4']) parts.push(net[layer].w, net[layer].b);
  parts.push(net.psqt ?? new Array(INPUTS).fill(0));
  const count = parts.reduce((n, p) => n + p.length, 0);
  const expected = INPUTS * acc + acc + h * 2 * acc + h + h * h + h + h + 1 + INPUTS;
  if (count !== expected) throw new Error(`the network has ${count} numbers, not ${expected} for ${acc}/${h}`);
  const out = new DataView(new ArrayBuffer(16 + 4 * count));
  [0x48, 0x58, 0x4e, 0x4e].forEach((b, i) => out.setUint8(i, b));   // "HXNN"
  out.setUint32(4, 1, true);
  out.setUint32(8, acc, true);
  out.setUint32(12, h, true);
  let at = 16;
  for (const p of parts) for (const x of p) { out.setFloat32(at, x, true); at += 4; }
  return new Uint8Array(out.buffer);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [from, to = fileURLToPath(new URL('../site/data/bot/hex-net.bin', import.meta.url))] = process.argv.slice(2);
  if (!from) throw new Error('usage: node tools/build-net.mjs <net.json> [out.bin]');
  const bytes = netBytes(JSON.parse(readFileSync(from, 'utf8')));
  writeFileSync(to, bytes);
  console.log(`Wrote ${to} (${(bytes.length / 1024).toFixed(0)} KB)`);
}
