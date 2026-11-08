// A fingerprint of the engine's source, built into it (ENGINE_SOURCE_HASH), so tests/wasm.test.mjs
// can tell whether site/js/bot/hex-engine.wasm was built from the source as it is now. FNV-1a over
// these files in this order, with carriage returns left out (Windows and Linux checkouts differ).
fn main() {
    let mut h: u64 = 0xcbf29ce484222325;
    for f in ["src/lib.rs", "src/hex.rs", "src/search.rs", "src/wasm.rs", "src/nn.rs"] {
        println!("cargo:rerun-if-changed={f}");
        let bytes = std::fs::read(f).unwrap_or_else(|e| panic!("can't read {f}: {e}"));
        for &b in bytes.iter().filter(|&&b| b != b'\r') {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    println!("cargo:rustc-env=ENGINE_SOURCE_HASH={h:016x}");
}
