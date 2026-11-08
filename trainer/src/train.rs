// Self-play, learning and matches, as tools/train-bot.mjs did before this replaced it (it's in git
// history), with the same options, defaults and learning maths. Why this method: learning from how
// these weak self-play games ended made the bot worse every time (35-48% against the untrained bot,
// Nov 7): they're mostly draws, decided by blunders long after the position. Each generation:
//   1. self-play: the bot plays itself, each game from a few random moves; every quiet position keeps
//      what the search found when it got there;
//   2. learning: the quick judgement is fitted to those search scores (and --lambda parts the games'
//      results), from this and the last two rounds' positions;
//   3. proof: a match against the old weights, kept only when better by twice the margin of error,
//      and then a match against the untrained weights, to show how far it's come.
// Options: --generations (3), --games (400), --match (400), --baseline (200), --keep (3), --nodes
// (2000 positions a move), --threads (this PC's less two), --lambda (0), --learn (values,shape,cells),
// --out (default site/data/bot/hex.json), --seed. compare A B: --match, --nodes, --nodes-b.
use crate::arg;
use crate::hex::*;
use crate::search::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

const MAX_PLIES: usize = 240;   // a game this long is called a draw
const SIZE: usize = TYPES * (1 + CELLS);

pub fn starting() -> Vec<f64> {
    let mut v = vec![0.0; SIZE];
    for (k, x) in [1.0, 3.0, 3.0, 5.0, 9.0].iter().enumerate() { v[k] = *x; }
    v
}

// A weights file: the whole of it (other fields are kept as they are) and its values
pub fn load(path: &str) -> (Value, Vec<f64>) {
    if path == "start" { return (json!({ "variant": "hex", "cells": CELLS, "generation": 0, "values": starting(), "history": [] }), starting()); }
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("can't read {path}: {e}"));
    let v: Value = serde_json::from_str(&text).expect("not JSON");
    let values: Vec<f64> = v["values"].as_array().expect("no values").iter().map(|x| x.as_f64().unwrap()).collect();
    assert_eq!(values.len(), SIZE, "values for {} cells expected", CELLS);
    (v, values)
}

// Seeded random numbers, so a run can be repeated
pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Rng { Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1) }
    pub fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn below(&mut self, n: usize) -> usize { ((self.next() * n as f64) as usize).min(n - 1) }
}

fn opening(r: &Rules, rng: &mut Rng) -> Vec<Move> {
    let n = 2 + rng.below(7);
    let mut p = r.start();
    let (mut list, mut scratch, mut out) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..n {
        r.legal(&p, &mut list, &mut scratch);
        if list.is_empty() { break; }
        let m = list[rng.below(list.len())];
        out.push(m);
        p = r.play(&p, &m);
    }
    out
}

pub struct Game { pub result: f64, pub positions: Vec<(Vec<i32>, f64)> }

// One game; the result is White's points
fn play_game(r: &Rules, s: &mut Searcher, opening: &[Move], white: &[f64], black: &[f64], nodes: [u64; 2], record: bool) -> Game {
    let mut p = r.start();
    for m in opening { p = r.play(&p, m); }
    let mut counts = std::collections::HashMap::new();
    s.seen.clear();
    s.seen.insert(p.hash);
    counts.insert(p.hash, 1u32);
    let mut kept = Vec::new();
    let (mut list, mut scratch) = (Vec::new(), Vec::new());
    let mut ply = opening.len();
    loop {
        r.legal(&p, &mut list, &mut scratch);
        if list.is_empty() {
            let result = if r.in_check(&p) { if p.turn == 0 { 0.0 } else { 1.0 } } else if p.turn == 0 { 0.75 } else { 0.25 };
            return Game { result, positions: kept };
        }
        if r.drawn(&p) || ply >= MAX_PLIES { return Game { result: 0.5, positions: kept }; }
        s.set_weights(if p.turn == 0 { white.to_vec() } else { black.to_vec() });
        let c = s.choose(&p, nodes[p.turn as usize]);
        let m = c.mv.unwrap();
        // Quiet positions only (not in check, and the move isn't a capture or promotion), with what
        // the search thought of them, for White, mates as 20 pawns
        if record && !r.in_check(&p) && m.captured == 0 && m.promo == 0 {
            let score = (if p.turn == 0 { c.score } else { -c.score }).clamp(-20.0, 20.0);
            kept.push((features(r, &p), score));
        }
        p = r.play(&p, &m);
        ply += 1;
        s.seen.insert(p.hash);
        let n = counts.entry(p.hash).or_insert(0);
        *n += 1;
        if *n >= 3 { return Game { result: 0.5, positions: kept }; }   // the same position three times
    }
}

struct Job { opening: Vec<Move>, white: usize, black: usize, nodes: [u64; 2], record: bool }

// Plays every job on `threads` threads; `weights` are the weight lists the jobs name by number
fn run_all(r: &Rules, jobs: &[Job], weights: &[Vec<f64>], threads: usize) -> Vec<Game> {
    let next = AtomicUsize::new(0);
    let done: Mutex<Vec<(usize, Game)>> = Mutex::new(Vec::with_capacity(jobs.len()));
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                let mut s = Searcher::new(r, weights[0].clone());
                let mut mine = Vec::new();
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= jobs.len() { break; }
                    let j = &jobs[i];
                    mine.push((i, play_game(r, &mut s, &j.opening, &weights[j.white], &weights[j.black], j.nodes, j.record)));
                }
                done.lock().unwrap().extend(mine);
            });
        }
    });
    let mut all = done.into_inner().unwrap();
    all.sort_by_key(|x| x.0);
    all.into_iter().map(|x| x.1).collect()
}

pub struct MatchResult { pub score: f64, pub sd: f64, pub wins: usize, pub losses: usize, pub games: usize }
impl MatchResult {
    fn said(&self) -> String {
        format!("{:.1}% ± {:.1} ({} wins, {} losses, {} draws)", self.score * 100.0, self.sd * 100.0, self.wins, self.losses, self.games - self.wins - self.losses)
    }
}

// Each opening twice, `a` once as each colour; a's score and its margin of error
fn play_match(r: &Rules, a: &[f64], b: &[f64], games: usize, nodes: (u64, u64), threads: usize, rng: &mut Rng) -> MatchResult {
    let weights = vec![a.to_vec(), b.to_vec()];
    let mut jobs = Vec::new();
    for _ in 0..games.div_ceil(2) {
        let o = opening(r, rng);
        jobs.push(Job { opening: o.clone(), white: 0, black: 1, nodes: [nodes.0, nodes.1], record: false });
        jobs.push(Job { opening: o, white: 1, black: 0, nodes: [nodes.1, nodes.0], record: false });
    }
    let games = run_all(r, &jobs, &weights, threads);
    let results: Vec<f64> = games.iter().zip(jobs.iter()).map(|(g, j)| if j.white == 0 { g.result } else { 1.0 - g.result }).collect();
    let n = results.len() as f64;
    let score = results.iter().sum::<f64>() / n;
    let sd = (results.iter().map(|x| (x - score).powi(2)).sum::<f64>() / n / n).sqrt();
    MatchResult { score, sd, wins: results.iter().filter(|&&x| x > 0.5).count(), losses: results.iter().filter(|&&x| x < 0.5).count(), games: results.len() }
}

fn threads_of(args: &[String]) -> usize {
    arg(args, "threads").and_then(|s| s.parse().ok())
        .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).saturating_sub(2).max(1))
}
fn num<T: std::str::FromStr>(args: &[String], name: &str, fallback: T) -> T { arg(args, name).and_then(|s| s.parse().ok()).unwrap_or(fallback) }

pub fn compare(r: &Rules, args: &[String]) {
    let (a, b) = (args.get(1).expect("compare A B"), args.get(2).expect("compare A B"));
    let nodes: u64 = num(args, "nodes", 2000);
    let nodes_b: u64 = num(args, "nodes-b", nodes);
    let games: usize = num(args, "match", 400);
    let mut rng = Rng::new(num(args, "seed", 12345));
    let t = std::time::Instant::now();
    let m = play_match(r, &load(a).1, &load(b).1, games, (nodes, nodes_b), threads_of(args), &mut rng);
    println!("  {a} against {b}: {}, {:.0} s", m.said(), t.elapsed().as_secs_f64());
}

pub fn train(r: &Rules, args: &[String]) {
    let generations: usize = num(args, "generations", 3);
    let games_per: usize = num(args, "games", 400);
    let match_games: usize = num(args, "match", 400);
    let baseline: usize = num(args, "baseline", 200);
    let keep: usize = num(args, "keep", 3);
    let nodes: u64 = num(args, "nodes", 2000);
    let lambda: f64 = num(args, "lambda", 0.0);
    let learn: Vec<String> = arg(args, "learn").unwrap_or("values,shape,cells").split(',').map(String::from).collect();
    let threads = threads_of(args);
    let out = arg(args, "out").unwrap_or("site/data/bot/hex.json").to_string();
    let (mut file, mut values) = if std::path::Path::new(&out).exists() { load(&out) } else { load("start") };
    let mut generation = file["generation"].as_u64().unwrap_or(0);
    let mut rng = Rng::new(num(args, "seed", 12345 + generation * 1000));
    println!("hex: generation {generation}, {threads} threads, {nodes} positions a move");
    let mut earlier: Vec<Vec<(Vec<i32>, f64, f64)>> = Vec::new();

    for _ in 0..generations {
        let t0 = std::time::Instant::now();
        // 1. Self-play
        let jobs: Vec<Job> = (0..games_per).map(|_| Job { opening: opening(r, &mut rng), white: 0, black: 0, nodes: [nodes, nodes], record: true }).collect();
        let games = run_all(r, &jobs, &[values.clone()], threads);
        earlier.push(games.iter().flat_map(|g| g.positions.iter().map(move |(f, s)| (f.clone(), g.result, *s))).collect());
        if earlier.len() > keep { earlier.remove(0); }
        let mut data: Vec<(Vec<i32>, f64, f64)> = earlier.iter().flatten().cloned().collect();
        for i in (1..data.len()).rev() { let j = rng.below(i + 1); data.swap(i, j); }   // mixed, not game by game
        let decided = games.iter().filter(|g| g.result != 0.5).count();
        println!("  self-play: {} games ({decided} decided); learning from {} positions of the last {} round(s), {:.0} s",
            games.len(), data.len(), earlier.len(), t0.elapsed().as_secs_f64());

        // 2. Learning
        let t1 = std::time::Instant::now();
        let shape = file.get("shape").cloned();
        let learned = tune(r, &values, shape.as_ref(), &data, &learn, lambda);
        let show = |a: &[f64]| a[..5].iter().map(|x| format!("{x:.2}")).collect::<Vec<_>>().join(" ");
        println!("  learning: {:.1} s, prediction error {:.5} -> {:.5}", t1.elapsed().as_secs_f64(), learned.before, learned.after);
        println!("    values (P N B R Q) {}; further up {}; middle {}", show(&learned.values), show(&learned.advance), show(&learned.centre));

        // 3. Proof
        let t2 = std::time::Instant::now();
        let m = play_match(r, &learned.values, &values, match_games, (nodes, nodes), threads, &mut rng);
        let kept = m.score - 2.0 * m.sd > 0.5;   // better by twice the match's margin of error
        println!("  match: new {}, {:.0} s: {}", m.said(), t2.elapsed().as_secs_f64(), if kept { "kept" } else { "not kept" });
        let mut entry = json!({
            "generation": generation + 1, "selfPlay": games.len(), "positions": data.len(),
            "match": { "games": m.games, "score": (m.score * 1000.0).round() / 1000.0, "wins": m.wins, "losses": m.losses },
            "kept": kept, "trainer": "rust", "nodes": nodes,
        });
        if kept {
            if baseline > 0 {
                let b = play_match(r, &learned.values, &starting(), baseline, (nodes, nodes), threads, &mut rng);
                println!("  against the untrained bot: {}", b.said());
                entry["untrained"] = json!({ "games": b.games, "score": (b.score * 1000.0).round() / 1000.0 });
            }
            generation += 1;
            values = learned.values.clone();
            file["generation"] = json!(generation);
            file["shape"] = json!({ "advance": learned.advance, "centre": learned.centre });
        }
        let history = file["history"].as_array().cloned().unwrap_or_default();
        file["history"] = Value::Array(history.into_iter().chain(std::iter::once(entry)).collect());
        file["values"] = json!(values.iter().map(|x| (x * 10000.0).round() / 10000.0).collect::<Vec<_>>());
        file["variant"] = json!("hex");
        file["cells"] = json!(CELLS);
        if let Some(dir) = std::path::Path::new(&out).parent() { std::fs::create_dir_all(dir).ok(); }
        std::fs::write(&out, serde_json::to_string(&file).unwrap() + "\n").expect("can't write the weights");
    }
}

// --- Learning: the bot's quick judgement fitted to targets, by gradient descent (Adam) -----------------
// What's learned, for each kind of piece: its value; how much better it is further up the board and
// nearer the middle (two numbers each, shared by every cell, so a few hundred games are enough);
// and an extra for each single cell, held near nothing unless many games call for it (learning every
// cell freely from 400 games made the bot much worse: 35.5%, Nov 7). The sigmoid's scale is fitted
// first, so lots of draws can't just shrink every number.
pub struct Learned { pub values: Vec<f64>, pub advance: Vec<f64>, pub centre: Vec<f64>, pub before: f64, pub after: f64 }

fn sig(x: f64) -> f64 { 1.0 / (1.0 + (-x).exp()) }

pub fn tune(r: &Rules, values: &[f64], shape: Option<&Value>, data: &[(Vec<i32>, f64, f64)], learn: &[String], lambda: f64) -> Learned {
    let info = &r.g.info;
    let get = |name: &str| -> Vec<f64> {
        shape.and_then(|s| s.get(name)).and_then(|a| a.as_array()).map(|a| a.iter().map(|x| x.as_f64().unwrap()).collect()).unwrap_or(vec![0.0; TYPES])
    };
    let (advance, centre) = (get("advance"), get("centre"));
    const EXTRA: usize = 3 * TYPES;
    let mut theta = vec![0.0; EXTRA + TYPES * CELLS];
    for t in 0..TYPES {
        theta[t] = values[t]; theta[TYPES + t] = advance[t]; theta[2 * TYPES + t] = centre[t];
        for i in 0..CELLS {
            theta[EXTRA + t * CELLS + i] = values[TYPES + t * CELLS + i] - advance[t] * info[i][0] - centre[t] * info[i][1];
        }
    }
    let old = theta.clone();
    let mut w = vec![0.0; SIZE];
    let bake = |theta: &[f64], w: &mut [f64]| {
        for t in 0..TYPES {
            w[t] = theta[t];
            for i in 0..CELLS { w[TYPES + t * CELLS + i] = theta[TYPES + t] * info[i][0] + theta[2 * TYPES + t] * info[i][1] + theta[EXTRA + t * CELLS + i]; }
        }
    };
    bake(&theta, &mut w);
    let eval_of = |f: &[i32], w: &[f64]| -> f64 { f.iter().map(|&k| if k > 0 { w[(k - 1) as usize] } else { -w[(-k - 1) as usize] }).sum() };
    let error = |k: f64, w: &[f64], target: &dyn Fn(f64, f64) -> f64| -> f64 {
        data.iter().map(|(f, res, sc)| (target(*res, *sc) - sig(k * eval_of(f, w))).powi(2)).sum::<f64>() / data.len() as f64
    };
    // The scale: the K that makes the current weights predict the results best
    let (mut lo, mut hi) = (0.02, 3.0);
    for _ in 0..40 {
        let a = hi - (hi - lo) / 1.618;
        let b = lo + (hi - lo) / 1.618;
        if error(a, &w, &|res, _| res) < error(b, &w, &|res, _| res) { hi = b } else { lo = a }
    }
    let k = (lo + hi) / 2.0;
    let target = |res: f64, sc: f64| lambda * res + (1.0 - lambda) * sig(k * sc);
    let targets: Vec<f64> = data.iter().map(|(_, res, sc)| target(*res, *sc)).collect();
    let before = error(k, &w, &target);

    const PULL: f64 = 1e-4; const HOLD: f64 = 1e-2; const RATE: f64 = 0.01; const EPOCHS: usize = 60; const BATCH: usize = 4096;
    let group = |i: usize| if i < TYPES { "values" } else if i < EXTRA { "shape" } else { "cells" };
    let may: Vec<bool> = (0..theta.len()).map(|i| learn.iter().any(|g| g == group(i))).collect();
    let (mut m, mut s) = (vec![0.0; theta.len()], vec![0.0; theta.len()]);
    let mut step = 0;
    let mut g = vec![0.0; SIZE];
    let mut gt = vec![0.0; theta.len()];
    for _ in 0..EPOCHS {
        let mut at = 0;
        while at < data.len() {
            let end = (at + BATCH).min(data.len());
            let n = (end - at) as f64;
            g.iter_mut().for_each(|x| *x = 0.0);
            for j in at..end {
                let f = &data[j].0;
                let p = sig(k * eval_of(f, &w));
                let d = 2.0 * (p - targets[j]) * p * (1.0 - p) * k / n;
                for &x in f { if x > 0 { g[(x - 1) as usize] += d } else { g[(-x - 1) as usize] -= d } }
            }
            gt.iter_mut().for_each(|x| *x = 0.0);
            for t in 0..TYPES {
                gt[t] = g[t];
                for i in 0..CELLS {
                    let gc = g[TYPES + t * CELLS + i];
                    gt[TYPES + t] += gc * info[i][0];
                    gt[2 * TYPES + t] += gc * info[i][1];
                    gt[EXTRA + t * CELLS + i] = gc;
                }
            }
            step += 1;
            for i in 0..theta.len() {
                if !may[i] { continue; }
                let pull = if i < EXTRA { 2.0 * PULL * (theta[i] - old[i]) } else { 2.0 * HOLD * theta[i] };
                let gk = gt[i] + pull;
                m[i] = 0.9 * m[i] + 0.1 * gk;
                s[i] = 0.999 * s[i] + 0.001 * gk * gk;
                theta[i] -= RATE * (m[i] / (1.0 - 0.9f64.powi(step))) / ((s[i] / (1.0 - 0.999f64.powi(step))).sqrt() + 1e-8);
            }
            theta[5] = 0.0;   // the king's value: both sides always have one
            bake(&theta, &mut w);
            at = end;
        }
    }
    let round = |a: &[f64]| a.iter().map(|x| (x * 1000.0).round() / 1000.0).collect::<Vec<_>>();
    let after = error(k, &w, &target);
    Learned { values: w, advance: round(&theta[TYPES..2 * TYPES]), centre: round(&theta[2 * TYPES..3 * TYPES]), before, after }
}
