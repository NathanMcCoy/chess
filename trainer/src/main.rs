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
        writeln!(out, "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}", rules.format(&p), names.join(" "), status, rules.in_check(&p), search::evaluate(rules, &p, &w),
            children.join("|"), rules.phase(&p), extras.join(",")).unwrap();
    }
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
    for (name, pos) in [("start", rules.start()), ("move 20", mid.unwrap())] {
        let mut s = search::Searcher::new(rules, train::starting());
        s.seen.insert(pos.hash);
        let t = std::time::Instant::now();
        let c = s.choose(&pos, nodes);
        let secs = t.elapsed().as_secs_f64();
        println!("{name}: depth {}, {} positions in {:.2} s ({:.0}/s), plays {}, score {:.2}",
            c.depth, c.nodes, secs, c.nodes as f64 / secs, rules.move_text(&c.mv.unwrap()), c.score);
    }
}
