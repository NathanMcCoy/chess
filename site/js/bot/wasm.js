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
    // A fingerprint of the Rust source it was built from (trainer/build.rs)
    sourceHash: () => answer(x.source_hash()),
  };
}
