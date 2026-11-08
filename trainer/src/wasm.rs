// The engine as WebAssembly, for the browser's bot (site/js/bot/worker.js). Text goes in and out
// through the module's memory:
//   alloc(n) -> where to write n bytes;  free(where, n) when done with them
//   set_weights(where, n) -> 1, or 0 if it isn't n = 2 * 6 * 92 + 2 * EXTRAS numbers: the middle-game
//     values, the endgame values, the extras' middle-game and endgame worth (bot.js's order)
//   choose(where, n, ms) -> the length of the answer (read it at out()): the game as text, "<start
//     position>\n<moves, space-separated>", answered "<move> <score> <depth> <positions>", "none" if
//     the game is over, or "error <why>"
//   source_hash() -> the length of the source's fingerprint, at out() (see build.rs)
// The page provides the clock: env.now(), in milliseconds (performance.now).
use crate::hex::*;
use crate::search::*;
use std::cell::RefCell;

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn now() -> f64;
}
fn clock() -> f64 { unsafe { now() } }

struct Engine { rules: &'static Rules, searcher: Searcher<'static>, out: Vec<u8> }

thread_local! {
    static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
}

fn with<T>(f: impl FnOnce(&mut Engine) -> T) -> T {
    ENGINE.with(|cell| {
        let mut slot = cell.borrow_mut();
        let e = slot.get_or_insert_with(|| {
            let rules: &'static Rules = Box::leak(Box::new(Rules::new()));
            Engine { rules, searcher: Searcher::new(rules, Weights::starting()), out: Vec::new() }
        });
        f(e)
    })
}

// Room for n bytes, starting on a multiple of 8 (so it can hold f64 numbers: the weights)
#[unsafe(no_mangle)]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u64>::with_capacity(n.div_ceil(8).max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p as *mut u8
}

/// # Safety
/// `p` and `n` must be what alloc() gave and was asked for.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn free(p: *mut u8, n: usize) {
    unsafe { drop(Vec::from_raw_parts(p as *mut u64, 0, n.div_ceil(8).max(1))); }
}

#[unsafe(no_mangle)]
pub extern "C" fn out() -> *const u8 { with(|e| e.out.as_ptr()) }

/// # Safety
/// `p` must point to `n` f64 numbers.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn set_weights(p: *const f64, n: usize) -> i32 {
    let size = TYPES * (1 + CELLS);
    if n != 2 * size + 2 * EXTRAS { return 0; }
    let x = unsafe { std::slice::from_raw_parts(p, n) };
    let w = Weights {
        mid: x[..size].to_vec(),
        end: x[size..2 * size].to_vec(),
        xmid: x[2 * size..2 * size + EXTRAS].try_into().unwrap(),
        xend: x[2 * size + EXTRAS..].try_into().unwrap(),
    };
    with(|e| e.searcher.set_weights(&w));
    1
}

/// # Safety
/// `p` must point to `n` bytes of UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn choose(p: *const u8, n: usize, ms: f64) -> usize {
    let text = String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(p, n) }).into_owned();
    with(|e| {
        let answer = answer(e, &text, ms);
        e.out = answer.into_bytes();
        e.out.len()
    })
}

fn answer(e: &mut Engine, text: &str, ms: f64) -> String {
    let mut parts = text.splitn(2, '\n');
    let start = parts.next().unwrap_or("");
    let moves = parts.next().unwrap_or("");
    let r = e.rules;
    let Some(mut p) = r.parse(start) else { return "error not a position".into() };
    e.searcher.seen.clear();
    e.searcher.seen.insert(p.hash);
    let (mut list, mut scratch) = (Vec::new(), Vec::new());
    for t in moves.split_whitespace() {
        r.legal(&p, &mut list, &mut scratch);
        let Some(m) = list.iter().find(|m| r.move_text(m) == t) else { return format!("error not a legal move: {t}") };
        p = r.play(&p, m);
        e.searcher.seen.insert(p.hash);
    }
    let c = e.searcher.choose_timed(&p, ms, clock);
    match c.mv {
        Some(m) => format!("{} {} {} {}", r.move_text(&m), c.score, c.depth, c.nodes),
        None => "none".into(),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn source_hash() -> usize {
    with(|e| { e.out = crate::SOURCE_HASH.as_bytes().to_vec(); e.out.len() })
}
