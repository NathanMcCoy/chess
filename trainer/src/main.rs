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
        _ => {
            eprintln!("usage: trainer train|compare|bench|check|felipe-check [options] (see src/main.rs and src/train.rs)");
            std::process::exit(2);
        }
    }
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
