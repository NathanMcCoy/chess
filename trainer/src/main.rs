// Trains the site's hex bot by self-play (site/data/bot/hex.json is what the page's bot loads). It
// replaced tools/train-bot.mjs (in git history: the same method and options), being about 40 times
// faster: 2 million positions a second on one thread against 59 thousand, and a whole round of
// training in 8.5 seconds against about 330 (Nov 8, i7-13700K, 22 threads).
//
//   cargo run --release -- train --generations 3        self-play, learning, a match; see train.rs
//   cargo run --release -- compare A.json start         a match between two weights files
//   cargo run --release -- bench                        how fast it searches
//   cargo run --release -- check --weights W.json       for tests/trainer.test.mjs: reads positions
//       (one a line) and writes, for each: its legal moves, how it stands (mate, stalemate, drawn or
//       -), check, its value for White by the weights, the position after each move, its phase,
//       and its extras
//   cargo run --release -- felipe-check --depth 3       the port of Felipe Lecot's engine
//       (src/felipe.rs) on positions read one a line, its table kept between them as one run of the
//       original keeps it: writes "<move> <score> <positions>" for each, to compare with the original
//
// Run from the chess folder or trainer/; paths are as given.
use engine::{felipe, hex, search};
mod train;
mod datagen;

use std::io::{BufRead, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rules = hex::Rules::new();
    match args.first().map(|s| s.as_str()) {
        Some("check") => check(&rules, &args),
        Some("bench") => bench(&rules, &args),
        Some("perft") => perft(&rules, &args),
        Some("rules-bench") => rules_bench(&rules, &args),
        Some("train") => train::train(&rules, &args),
        Some("compare") => train::compare(&rules, &args),
        Some("felipe-check") => felipe_check(&rules, &args),
        Some("vs-felipe") => train::vs_felipe(&rules, &args),
        Some("gen-data") => datagen::gen_data(&rules, &args),
        Some("nn-check") => nn_check(&rules, &args),
        Some("nn-compare") => nn_compare(&rules, &args),
        Some("nn-eval") => nn_eval(&rules, &args),
        Some("net-match") => train::net_match(&rules, &args),
        _ => {
            eprintln!("usage: trainer train|compare|bench|check|felipe-check|vs-felipe|gen-data|nn-check|net-match [options] (see src/main.rs and src/train.rs)");
            std::process::exit(2);
        }
    }
}

// nn-compare --net N.json --data D.bin [--weights W.json] [--k 0.6]: how well the network's quick
// judgement and the weights' predict the training target (sigmoid(k * search score)) on the
// positions in D, as the mean squared error in chances of winning (smaller is better), and how often
// the two even agree on which side is better
fn nn_compare(rules: &hex::Rules, args: &[String]) {
    let net = train::load_net(arg(args, "net").expect("--net file"));
    let w = train::load(arg(args, "weights").unwrap_or("site/data/bot/hex.json")).1;
    let k: f64 = arg(args, "k").and_then(|s| s.parse().ok()).unwrap_or(0.6);
    let bytes = std::fs::read(arg(args, "data").expect("--data file")).unwrap();
    let take: usize = arg(args, "positions").and_then(|s| s.parse().ok()).unwrap_or(100_000);
    let sig = |x: f64| 1.0 / (1.0 + (-x).exp());
    let (mut e_net, mut e_w, mut agree, mut n) = (0.0, 0.0, 0, 0);
    // Spread through the file, not just its first games
    let total = bytes.len() / 100;
    let step = (total / take).max(1);
    for rec in bytes.chunks_exact(100).step_by(step) {
        let board: [u8; hex::CELLS] = rec[..91].try_into().unwrap();
        let p = rules.from_board(board, rec[91]);
        let score = f32::from_le_bytes(rec[92..96].try_into().unwrap()) as f64;
        let target = sig(k * score);
        let a = net.evaluate(rules, &p) as f64;
        let b = { let s = search::evaluate(rules, &p, &w); if p.turn == 0 { s } else { -s } };
        e_net += (sig(k * a) - target).powi(2);
        e_w += (sig(k * b) - target).powi(2);
        if (a > 0.0) == (b > 0.0) { agree += 1; }
        n += 1;
    }
    println!("{n} positions: error by the network {:.5}, by the weights {:.5}; they agree on who's better in {:.1}%", e_net / n as f64, e_w / n as f64, 100.0 * agree as f64 / n as f64);
}

// nn-eval --net N.json --states F.txt: the network's judgement (and the weights') of each position in
// F (one a line, as hex.js writes them), for the side to move, in pawns
fn nn_eval(rules: &hex::Rules, args: &[String]) {
    let net = train::load_net(arg(args, "net").expect("--net file"));
    let w = train::load(arg(args, "weights").unwrap_or("site/data/bot/hex.json")).1;
    let text = std::fs::read_to_string(arg(args, "states").expect("--states file")).unwrap();
    for line in text.lines().map(|l| l.trim_start_matches('\u{feff}').trim()).filter(|l| !l.is_empty()) {
        let Some(p) = rules.parse(line) else { println!("invalid: {line}"); continue };
        let s = search::evaluate(rules, &p, &w);
        println!("network {:7.2}   weights {:7.2}   {line}", net.evaluate(rules, &p), if p.turn == 0 { s } else { -s });
    }
}

// nn-check --net N.json: what nn.rs makes of the positions nn/train.py saved in the file with
// PyTorch's answers, and how far apart the two are (they add up in a different order, so a little)
fn nn_check(rules: &hex::Rules, args: &[String]) {
    let path = arg(args, "net").expect("--net file");
    let net = train::load_net(path);
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut worst: f64 = 0.0;
    let checks = v["check"].as_array().expect("no positions to check");
    for c in checks {
        let board: Vec<u8> = c["board"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
        let p = rules.from_board(board.try_into().unwrap(), c["turn"].as_u64().unwrap() as u8);
        let diff = (net.evaluate(rules, &p) as f64 - c["value"].as_f64().unwrap()).abs();
        worst = worst.max(diff);
    }
    println!("{} positions: the largest difference from PyTorch is {worst:.6} pawns", checks.len());

    // The first layer kept up move by move (as the search does) against worked out afresh from the
    // board, along random games, with how many captures, en passant and promotions they met
    let mut rng = train::Rng::new(7);
    let (mut worst, mut positions, mut captures, mut ep, mut promos) = (0f32, 0, 0, 0, 0);
    let (mut list, mut scratch) = (Vec::new(), Vec::new());
    for _ in 0..300 {
        let mut p = rules.start();
        let mut acc = engine::nn::Acc::default();
        net.refresh(rules, &p, &mut acc);
        for _ in 0..150 {
            rules.legal(&p, &mut list, &mut scratch);
            if list.is_empty() { break; }
            // Captures and pawn moves more often than chance, so the rare cases come up
            let pick: Vec<_> = list.iter().filter(|m| m.captured != 0 || m.promo != 0 || m.en_passant).cloned().collect();
            let m = if !pick.is_empty() && rng.next() < 0.5 { pick[rng.below(pick.len())] } else { list[rng.below(list.len())] };
            let mut next = engine::nn::Acc::default();
            net.update(rules, &p, &m, &acc, &mut next);
            if m.captured != 0 { captures += 1; }
            if m.en_passant { ep += 1; }
            if m.promo != 0 { promos += 1; }
            p = rules.play(&p, &m);
            acc = next;
            worst = worst.max((net.output(&acc, p.turn) - net.evaluate(rules, &p)).abs());
            positions += 1;
        }
    }
    println!("{positions} positions along random games ({captures} captures, {ep} en passant, {promos} promotions): kept up move by move against afresh, at most {worst:.6} pawns apart");
}

fn felipe_check(rules: &hex::Rules, args: &[String]) {
    let depth: i32 = arg(args, "depth").and_then(|s| s.parse().ok()).unwrap_or(3);
    let mut f = felipe::Felipe::new(rules);
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let Some(p) = rules.parse(line.trim()) else { writeln!(out, "invalid").unwrap(); continue };
        let c = f.choose(&p, depth);
        let mv = c.mv.map(|m| rules.move_text(&m)).unwrap_or_else(|| "none".into());
        writeln!(out, "{mv} {} {}", c.score, c.nodes).unwrap();
        out.flush().unwrap();   // at once: whoever sent the position is waiting for this answer
    }
}

pub fn arg<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == &format!("--{name}")).and_then(|i| args.get(i + 1)).map(|s| s.as_str())
}

fn check(rules: &hex::Rules, args: &[String]) {
    let w = match arg(args, "weights") { Some(f) => train::load(f).1, None => train::starting() };
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    let (mut list, mut scratch) = (Vec::new(), Vec::new());
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        let line = line.trim();
        if line.is_empty() { continue; }
        let Some(p) = rules.parse(line) else { writeln!(out, "invalid").unwrap(); continue };
        rules.legal(&p, &mut list, &mut scratch);
        let mut moves: Vec<(String, String)> = list.iter().map(|m| (rules.move_text(m), rules.format(&rules.play(&p, m)))).collect();
        moves.sort();
        let status = if list.is_empty() { if rules.in_check(&p) { "mate" } else { "stalemate" } } else if rules.drawn(&p) { "drawn" } else { "-" };
        let names: Vec<&str> = moves.iter().map(|m| m.0.as_str()).collect();
        let children: Vec<&str> = moves.iter().map(|m| m.1.as_str()).collect();
        let extras: Vec<String> = rules.extras(&p).iter().map(|x| x.to_string()).collect();
        // The captures-only search's shortcut (legal_captures: only captures and promotions made,
        // "any legal move" by a quick look) must agree with the full list, order included
        let full: Vec<String> = list.iter().filter(|m| m.captured != 0 || m.promo != 0).map(|m| rules.move_text(m)).collect();
        let (mut caps, mut scratch2) = (Vec::new(), Vec::new());
        let any = rules.legal_captures(&p, &mut caps, &mut scratch2);
        let quick: Vec<String> = caps.iter().map(|m| rules.move_text(m)).collect();
        let captures = if quick == full && any == !list.is_empty() { "ok".to_string() } else { format!("captures {quick:?} against {full:?}, any {any}") };
        writeln!(out, "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}", rules.format(&p), names.join(" "), status, rules.in_check(&p), search::evaluate(rules, &p, &w),
            children.join("|"), rules.phase(&p), extras.join(","), captures).unwrap();
    }
}

// perft --depth N: how many move sequences of N moves there are from the start (and from a middle
// game), the standard check for a move generator: a change meant only to make it faster must give
// the same counts. Counted with legal(); a sequence ends early at mate or stalemate.
fn perft(rules: &hex::Rules, args: &[String]) {
    let depth: u32 = arg(args, "depth").and_then(|s| s.parse().ok()).unwrap_or(4);
    fn count(r: &hex::Rules, p: &hex::Pos, depth: u32, lists: &mut Vec<Vec<hex::Move>>, scratch: &mut Vec<hex::Move>) -> u64 {
        if depth == 0 { return 1; }
        let mut list = std::mem::take(&mut lists[depth as usize]);
        r.legal(p, &mut list, scratch);
        let n = if depth == 1 { list.len() as u64 } else { list.iter().map(|m| count(r, &r.play(p, m), depth - 1, lists, scratch)).sum() };
        lists[depth as usize] = list;
        n
    }
    // The middle game: 16 moves picked at random from the moves sorted by name, so nothing about the
    // generator (its order) or the search can change which position it is
    let mut mid = rules.start();
    let mut x = 2026u64;
    let (mut l, mut sc) = (Vec::new(), Vec::new());
    for _ in 0..16 {
        rules.legal(&mid, &mut l, &mut sc);
        l.sort_by_key(|m| rules.move_text(m));
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        mid = rules.play(&mid, &l[(x % l.len() as u64) as usize]);
    }
    for (name, p) in [("start", rules.start()), ("move 8", mid)] {
        let mut lists = vec![Vec::new(); depth as usize + 1];
        let t = std::time::Instant::now();
        let n = count(rules, &p, depth, &mut lists, &mut Vec::new());
        println!("perft {name} depth {depth}: {n} ({:.2} s)", t.elapsed().as_secs_f64());
    }
}

// rules-bench: the rules functions one at a time, in nanoseconds a call, on positions from the bot's
// own games (where the search spends its time)
fn rules_bench(rules: &hex::Rules, _args: &[String]) {
    let mut positions = Vec::new();
    let mut rng = 12345u64;
    for _ in 0..40 {
        let mut p = rules.start();
        for ply in 0..80 {
            positions.push(p.clone());
            let mut list = Vec::new();
            rules.legal(&p, &mut list, &mut Vec::new());
            if list.is_empty() || rules.drawn(&p) { break; }
            rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17;
            // At random from the moves sorted by name (not the search's choice, which the generator's
            // order would change), with captures taken when there are any, to reach real middle games
            list.sort_by_key(|m| rules.move_text(m));
            let caps: Vec<hex::Move> = list.iter().filter(|m| m.captured != 0).copied().collect();
            let pick = if ply >= 6 && !caps.is_empty() && rng % 2 == 0 { &caps } else { &list };
            let m = pick[(rng % pick.len() as u64) as usize];
            p = rules.play(&p, &m);
        }
    }
    let (mut list, mut scratch) = (Vec::with_capacity(256), Vec::with_capacity(256));
    let time = |name: &str, calls: usize, f: &mut dyn FnMut() -> u64| {
        let t = std::time::Instant::now();
        let mut sink = 0u64;
        for _ in 0..20 { sink = sink.wrapping_add(f()); }
        let ns = t.elapsed().as_nanos() as f64 / (20 * calls) as f64;
        println!("{name:<22} {ns:>7.1} ns a call   ({sink})");
    };
    let n = positions.len();
    let moves: usize = positions.iter().map(|p| { rules.legal(p, &mut list, &mut scratch); list.len() }).sum();
    println!("{n} positions, {:.1} legal moves each on average", moves as f64 / n as f64);
    time("pseudo", n, &mut || positions.iter().map(|p| { rules.pseudo(p, &mut list); list.len() as u64 }).sum());
    time("pseudo_captures", n, &mut || positions.iter().map(|p| { rules.pseudo_captures(p, &mut list); list.len() as u64 }).sum());
    time("legal", n, &mut || positions.iter().map(|p| { rules.legal(p, &mut list, &mut scratch); list.len() as u64 }).sum());
    time("legal_captures", n, &mut || positions.iter().map(|p| rules.legal_captures(p, &mut list, &mut scratch) as u64 + list.len() as u64).sum());
    time("in_check", n, &mut || positions.iter().map(|p| rules.in_check(p) as u64).sum());
    time("drawn", n, &mut || positions.iter().map(|p| rules.drawn(p) as u64).sum());
    let all: Vec<(usize, hex::Move)> = positions.iter().enumerate().flat_map(|(i, p)| { rules.legal(p, &mut list, &mut scratch); list.iter().map(move |m| (i, *m)).collect::<Vec<_>>() }).collect();
    time("play (a move)", all.len(), &mut || all.iter().map(|(i, m)| rules.play(&positions[*i], m).hash & 1).sum());
    time("safe (a move)", all.len(), &mut || all.iter().map(|(i, m)| rules.safe(&positions[*i], m) as u64).sum());
}

fn bench(rules: &hex::Rules, args: &[String]) {
    let nodes: u64 = arg(args, "nodes").and_then(|s| s.parse().ok()).unwrap_or(2_000_000);
    let w = train::starting();
    let mut s = search::Searcher::new(rules, w);
    // The start, and a middle game reached by the bot playing itself quickly
    let mut p = rules.start();
    let mut mid = None;
    for i in 0..20 {
        s.seen.insert(p.hash);
        let c = s.choose(&p, 3000);
        p = rules.play(&p, &c.mv.unwrap());
        if i == 19 { mid = Some(p.clone()); }
    }
    // Judging with: --weights W.json (default: the untrained weights), or --net N.json
    let weights = arg(args, "weights").map(|f| train::load(f).1).unwrap_or_else(train::starting);
    let net = arg(args, "net").map(train::load_net);
    for (name, pos) in [("start", rules.start()), ("move 20", mid.unwrap())] {
        let mut s = search::Searcher::new(rules, weights.clone());
        s.set_net(net.clone());
        s.seen.insert(pos.hash);
        let t = std::time::Instant::now();
        let c = s.choose(&pos, nodes);
        let secs = t.elapsed().as_secs_f64();
        println!("{name}: depth {}, {} positions in {:.2} s ({:.0}/s), plays {}, score {:.2}",
            c.depth, c.nodes, secs, c.nodes as f64 / secs, rules.move_text(&c.mv.unwrap()), c.score);
    }
    // --suite: 16 positions along a game (every 4th move of the bot playing itself), each searched
    // for --suite positions; the total speed, and a fingerprint of every answer (move, score, depth,
    // positions looked at): a change meant only to be faster must leave the fingerprint as it was
    if let Some(per) = arg(args, "suite").and_then(|s| s.parse::<u64>().ok()) {
        // The suite's game: moves at random from those sorted by name (captures half the time), so
        // neither the search nor the generator's order can change which positions it holds (Nov 8:
        // a game played by the search moved the suite when either changed)
        let mut p = rules.start();
        let mut suite = Vec::new();
        let mut x = 777u64;
        let (mut l, mut sc) = (Vec::new(), Vec::new());
        for i in 0..64 {
            if i % 4 == 0 { suite.push(p.clone()); }
            rules.legal(&p, &mut l, &mut sc);
            if l.is_empty() { break; }
            l.sort_by_key(|m| rules.move_text(m));
            x ^= x << 13; x ^= x >> 7; x ^= x << 17;
            let caps: Vec<hex::Move> = l.iter().filter(|m| m.captured != 0).copied().collect();
            let pick = if i >= 6 && !caps.is_empty() && x % 2 == 0 { &caps } else { &l };
            p = rules.play(&p, &pick[(x % pick.len() as u64) as usize]);
        }
        let (mut total, mut secs, mut print, mut depths) = (0u64, 0f64, 0xcbf29ce484222325u64, 0u32);
        let features: u32 = arg(args, "features").and_then(|s| s.parse().ok()).unwrap_or(search::DEFAULT_FEATURES);
        for pos in &suite {
            let mut s = search::Searcher::new(rules, weights.clone());
            s.set_net(net.clone());
            s.features = features;
            s.seen.insert(pos.hash);
            let t = std::time::Instant::now();
            let c = s.choose(pos, per);
            depths += c.depth;
            secs += t.elapsed().as_secs_f64();
            total += c.nodes;
            let text = format!("{} {:.6} {} {}", c.mv.map(|m| rules.move_text(&m)).unwrap_or_default(), c.score, c.depth, c.nodes);
            for b in text.bytes() { print = (print ^ b as u64).wrapping_mul(0x100000001b3); }
        }
        println!("suite: {} positions, {total} looked at in {secs:.2} s ({:.0}/s), depth {:.2} on average, fingerprint {print:016x}", suite.len(), total as f64 / secs, depths as f64 / suite.len() as f64);
    }
}
