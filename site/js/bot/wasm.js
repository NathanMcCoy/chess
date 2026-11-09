// The Rust engine as WebAssembly (hex-engine.wasm, built from trainer/src by tools/build-engine.mjs):
// the same rules, search and judgement as bot.js for hex (tests/trainer.test.mjs checks the Rust
// against hex.js and bot.js), about 40 times faster. worker.js uses it, and so does
// tests/wasm.test.mjs. Text and numbers go through the module's memory (see trainer/src/wasm.rs).
export async function loadEngine(bytes, now = () => performance.now()) {
  const { instance } = await WebAssembly.instantiate(bytes, { env: { now } });
  const x = instance.exports;
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const answer = n => decoder.decode(new Uint8Array(x.memory.buffer, x.out(), n));
  return {
    // Weights as bot.js uses them (version 1 or 2); `extras`: how many extras the variant has
    setWeights(w, extras) {
      const none = new Array(extras).fill(0);
      const all = Float64Array.from([...w.values, ...(w.endgame || w.values), ...(w.extras?.middle || none), ...(w.extras?.end || none)]);
      const p = x.alloc(all.byteLength);
      new Float64Array(x.memory.buffer, p, all.length).set(all);
      const ok = x.set_weights(p, all.length);
      x.free(p, all.byteLength);
      if (!ok) throw new Error('the engine wants weights of another size');
    },
    // A neural network (the bytes of a hex-net.bin, from tools/build-net.mjs) to judge positions by
    // instead of the weights; null: back to the weights
    setNet(bytes) {
      if (!bytes) { x.set_net(0, 0, 0, 0); return; }
      const view = new DataView(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
      if (view.byteLength < 16 || view.getUint32(0, false) !== 0x48584e4e || view.getUint32(4, true) !== 1) {
        throw new Error('not a network file');
      }
      const acc = view.getUint32(8, true), hidden = view.getUint32(12, true);
      const n = (view.byteLength - 16) / 4;
      if (!Number.isInteger(n)) throw new Error('the network file is cut short');
      const p = x.alloc(n * 4);
      new Uint8Array(x.memory.buffer, p, n * 4).set(new Uint8Array(view.buffer, view.byteOffset + 16, n * 4));
      const ok = x.set_net(p, n, acc, hidden);
      x.free(p, n * 4);
      if (!ok) throw new Error('the engine wants a network of another size');
    },
    // The network's value of a position: 91 cells as the engine numbers pieces, and the side to
    // move (0 White, 1 Black); in pawns for the side to move (NaN without a network)
    netValue(board, turn) {
      const p = x.alloc(92);
      const b = new Uint8Array(x.memory.buffer, p, 92);
      b.set(board);
      b[91] = turn;
      const v = x.net_value(p);
      x.free(p, 92);
      return v;
    },
    // A move for the game start + moves, in about `ms` milliseconds: { move, score, depth, nodes },
    // or { move: null } when the game is over
    choose(start, moves, ms) {
      const bytes = encoder.encode(`${start}\n${moves.join(' ')}`);
      const p = x.alloc(bytes.length);
      new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
      const n = x.choose(p, bytes.length, ms);
      x.free(p, bytes.length);
      const text = answer(n);
      if (text === 'none') return { move: null };
      if (text.startsWith('error')) throw new Error(text.slice(6));
      const [move, score, depth, nodes] = text.split(' ');
      return { move, score: Number(score), depth: Number(depth), nodes: Number(nodes) };
    },
    // The best `count` lines for the game start + moves, for the game review, each searched for about
    // `ms` milliseconds: [{ score, depth, pv: [moves] }], best first (scores as choose's), or [] when
    // the game is over
    analyse(start, moves, ms, count = 1) {
      const bytes = encoder.encode(`${start}\n${moves.join(' ')}`);
      const p = x.alloc(bytes.length);
      new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
      const n = x.analyse(p, bytes.length, ms, count);
      x.free(p, bytes.length);
      const text = answer(n);
      if (text === 'none') return [];
      if (text.startsWith('error')) throw new Error(text.slice(6));
      return text.split('\n').map(line => {
        const [score, depth, ...pv] = line.split(' ');
        return { score: Number(score), depth: Number(depth), pv };
      });
    },
    // A fingerprint of the Rust source it was built from (trainer/build.rs)
    sourceHash: () => answer(x.source_hash()),
  };
}
