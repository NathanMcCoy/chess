// The site's hex bot in Rust: Gliński's rules (hex.rs, the same as site/js/variants/hex.js), the
// search and judgement (search.rs, as site/js/bot/bot.js). The trainer (main.rs) uses it on this PC;
// built to WebAssembly (wasm.rs), it's the browser's bot for hex.
pub mod hex;
pub mod search;
pub mod felipe;   // a port of Felipe Lecot's Hex Chess Engine, to spar with (see the file)
#[cfg(target_arch = "wasm32")]
mod wasm;

// A fingerprint of this source (see build.rs)
pub const SOURCE_HASH: &str = env!("ENGINE_SOURCE_HASH");
