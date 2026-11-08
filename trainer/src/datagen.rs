// Positions for training a neural network to judge hex positions (nn/), from the bot playing itself.
//
//   trainer gen-data --games 20000 --nodes 8000 --out D:/TRUENAS/CLAUDE/nn-data/gen5.bin
//
// Every quiet position (not in check, the move chosen not a capture or promotion: its value isn't
// about to swing) is kept with what the search found and how the game ended. A record is 100 bytes:
//   91   the cells, hex.rs's order and piece codes (0 empty; 1 P 2 N 3 B 4 R 5 Q 6 K, +8 Black's)
//   1    the side to move (0 White, 1 Black)
//   4    the search's score, for the side to move, in pawns (f32, mates as 20)
//   4    how the game ended, for the side to move: 1, 0.5, 0, or Glinski's 0.75 and 0.25 (f32)
// Options: --weights (the bot that plays: site/data/bot/hex.json), --net (a network judges instead), --random (the chance of a random
// move instead of the bot's, in the first 20 moves: 0.05, for variety), --threads, --seed.
use crate::arg;
use crate::train::{load, Rng};
use engine::hex::*;
use engine::search::*;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

pub const RECORD: usize = 100;
const MAX_PLIES: usize = 240;

fn game(r: &Rules, s: &mut Searcher, nodes: u64, random: f64, rng: &mut Rng, out: &mut Vec<u8>) -> usize {
    let mut p = r.start();
    let (mut list, mut scratch) = (Vec::new(), Vec::new());
    // A few random moves to start, so the games differ
    for _ in 0..2 + rng.below(7) {
        r.legal(&p, &mut list, &mut scratch);
        if list.is_empty() { return 0; }
        p = r.play(&p, &list[rng.below(list.len())]);
    }
    let mut counts = std::collections::HashMap::new();
    s.seen.clear();
    s.seen.insert(p.hash);
    counts.insert(p.hash, 1u32);
    let mut kept: Vec<([u8; CELLS], u8, f32)> = Vec::new();
    let result_for_white: f64;
    let mut ply = 0;
    loop {
        r.legal(&p, &mut list, &mut scratch);
        if list.is_empty() {
            result_for_white = if r.in_check(&p) { if p.turn == 0 { 0.0 } else { 1.0 } } else if p.turn == 0 { 0.75 } else { 0.25 };
            break;
        }
        if r.drawn(&p) || ply >= MAX_PLIES { result_for_white = 0.5; break; }
        let c = s.choose(&p, nodes);
        let best = c.mv.unwrap();
        if !r.in_check(&p) && best.captured == 0 && best.promo == 0 {
            kept.push((p.board, p.turn, c.score.clamp(-20.0, 20.0) as f32));
        }
        // Now and then early on, a random move instead, for positions the bot wouldn't choose
        let m = if ply < 40 && rng.next() < random { list[rng.below(list.len())] } else { best };
        p = r.play(&p, &m);
        ply += 1;
        s.seen.insert(p.hash);
        let n = counts.entry(p.hash).or_insert(0);
        *n += 1;
        if *n >= 3 { result_for_white = 0.5; break; }
    }
    for (board, turn, score) in &kept {
        out.extend_from_slice(board);
        out.push(*turn);
        out.extend_from_slice(&score.to_le_bytes());
        let mine = if *turn == 0 { result_for_white } else { 1.0 - result_for_white };
        out.extend_from_slice(&(mine as f32).to_le_bytes());
    }
    kept.len()
}

pub fn gen_data(r: &Rules, args: &[String]) {
    let num = |name: &str, fallback: f64| arg(args, name).and_then(|s| s.parse().ok()).unwrap_or(fallback);
    let games = num("games", 1000.0) as usize;
    let nodes = num("nodes", 8000.0) as u64;
    let random = num("random", 0.05);
    let seed = num("seed", 1.0) as u64;
    let threads = arg(args, "threads").and_then(|s| s.parse().ok())
        .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).saturating_sub(2).max(1));
    let out_path = arg(args, "out").expect("--out file");
    let weights = load(arg(args, "weights").unwrap_or("site/data/bot/hex.json")).1;
    let net = arg(args, "net").map(crate::train::load_net);   // judging by a network instead (the loop: its own games)
    let t = std::time::Instant::now();
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let file = Mutex::new(std::io::BufWriter::new(std::fs::File::create(out_path).expect("can't write the data")));
    let positions = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                let mut s = Searcher::new(r, weights.clone());
                s.set_net(net.clone());
                let mut buf = Vec::new();
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= games { break; }
                    let mut rng = Rng::new(seed * 1_000_003 + i as u64);
                    positions.fetch_add(game(r, &mut s, nodes, random, &mut rng, &mut buf), Ordering::Relaxed);
                    if buf.len() > 1 << 20 { file.lock().unwrap().write_all(&buf).unwrap(); buf.clear(); }
                    let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if d % 1000 == 0 { eprintln!("  {d} games, {} positions, {:.0} s", positions.load(Ordering::Relaxed), t.elapsed().as_secs_f64()); }
                }
                file.lock().unwrap().write_all(&buf).unwrap();
            });
        }
    });
    file.into_inner().unwrap().flush().unwrap();
    println!("{games} games, {} positions ({} bytes each) in {:.0} s -> {out_path}", positions.load(Ordering::Relaxed), RECORD, t.elapsed().as_secs_f64());
}
