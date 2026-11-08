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
// (2000 positions a move), --threads (this PC's less two), --lambda (0), --learn (which groups may
// change: values,shape,cells,extras), --out (default site/data/bot/hex.json), --seed, --opponent
// felipe:<depth> (part of the games, --share 0.5, against the port of Felipe Lecot's engine; kept
// rounds also play it, --meter 200 games).
// vs-felipe A: --depth (4), --nodes, --match (200).
// compare A B: --match, --nodes, --nodes-b.
use crate::arg;
use engine::hex::*;
use engine::search::*;
use engine::felipe::Felipe;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

const MAX_PLIES: usize = 240;   // a game this long is called a draw
const SIZE: usize = TYPES * (1 + CELLS);

pub fn starting() -> Weights { Weights::starting() }

// How each kind of piece gains from being further up and nearer the middle (see tune), in each phase
#[derive(Clone)]
pub struct Shape { pub adv: [[f64; TYPES]; 2], pub cen: [[f64; TYPES]; 2] }   // [middle, end]

fn numbers(v: &Value) -> Option<Vec<f64>> { v.as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect()) }
fn six(v: Option<Vec<f64>>) -> Option<[f64; TYPES]> { v.filter(|a| a.len() == TYPES).map(|a| a.try_into().unwrap()) }

// A weights file: the whole of it (other fields are kept as they are), its weights and its shape.
// A version 1 file (values only) gets the same endgame, and extras worth nothing (as bot.js reads it).
pub fn load(path: &str) -> (Value, Weights, Shape) {
    let file: Value = if path == "start" {
        json!({ "variant": "hex", "cells": CELLS, "generation": 0, "values": starting().mid, "history": [] })
    } else {
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("can't read {path}: {e}"));
        serde_json::from_str(&text).expect("not JSON")
    };
    let mid = numbers(&file["values"]).expect("no values");
    assert_eq!(mid.len(), SIZE, "values for {CELLS} cells expected");
    let end = numbers(&file["endgame"]).filter(|e| e.len() == SIZE).unwrap_or_else(|| mid.clone());
    let extra = |name: &str| -> [f64; EXTRAS] {
        numbers(&file["extras"][name]).filter(|a| a.len() == EXTRAS).map(|a| a.try_into().unwrap()).unwrap_or([0.0; EXTRAS])
    };
    let s = &file["shape"];
    let am = six(numbers(&s["advance"])).unwrap_or([0.0; TYPES]);
    let cm = six(numbers(&s["centre"])).unwrap_or([0.0; TYPES]);
    let shape = Shape { adv: [am, six(numbers(&s["endAdvance"])).unwrap_or(am)], cen: [cm, six(numbers(&s["endCentre"])).unwrap_or(cm)] };
    let w = Weights { mid, end, xmid: extra("middle"), xend: extra("end") };
    (file, w, shape)
}

fn store(file: &mut Value, w: &Weights, shape: &Shape) {
    let round = |a: &[f64], places: f64| a.iter().map(|x| (x * places).round() / places).collect::<Vec<_>>();
    file["version"] = json!(2);
    file["variant"] = json!("hex");
    file["cells"] = json!(CELLS);
    file["values"] = json!(round(&w.mid, 1e4));
    file["endgame"] = json!(round(&w.end, 1e4));
    file["extras"] = json!({ "names": EXTRA_NAMES, "middle": round(&w.xmid, 1e4), "end": round(&w.xend, 1e4) });
    file["shape"] = json!({ "advance": round(&shape.adv[0], 1e3), "centre": round(&shape.cen[0], 1e3), "endAdvance": round(&shape.adv[1], 1e3), "endCentre": round(&shape.cen[1], 1e3) });
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

pub struct Game { pub result: f64, pub positions: Vec<(Sample, f64)> }

// One game; the result is White's points
// Who plays a side: our bot (which weights, by number, and how many positions it looks at a move),
// or the port of Felipe Lecot's engine (felipe.rs) to a fixed depth, its own way of playing
#[derive(Clone, Copy)]
pub enum Player { Bot(usize, u64), Felipe(i32) }

fn play_game(r: &Rules, s: &mut Searcher, f: &mut Felipe, opening: &[Move], weights: &[Weights], players: [Player; 2], record: bool) -> Game {
    let mut p = r.start();
    for m in opening { p = r.play(&p, m); }
    f.clear();   // a fresh table each game, as if the original were started again
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
        let c = match players[p.turn as usize] {
            Player::Bot(w, nodes) => { s.set_weights(&weights[w]); s.choose(&p, nodes) }
            Player::Felipe(depth) => {
                let c = f.choose(&p, depth);
                // It can come back without a move (as the original would answer an impossible one):
                // then its first legal move, so the game goes on
                engine::search::Choice { mv: Some(c.mv.unwrap_or(list[0])), score: c.score as f64 / 100.0, depth: depth as u32, nodes: c.nodes }
            }
        };
        let m = c.mv.unwrap();
        // Quiet positions only (not in check, and the move isn't a capture or promotion), with what
        // the search thought of them, for White, mates as 20 pawns
        // (and only where our bot moved: an opponent's score isn't our search's)
        if record && matches!(players[p.turn as usize], Player::Bot(..)) && !r.in_check(&p) && m.captured == 0 && m.promo == 0 {
            let score = (if p.turn == 0 { c.score } else { -c.score }).clamp(-20.0, 20.0);
            kept.push((sample(r, &p), score));
        }
        p = r.play(&p, &m);
        ply += 1;
        s.seen.insert(p.hash);
        let n = counts.entry(p.hash).or_insert(0);
        *n += 1;
        if *n >= 3 { return Game { result: 0.5, positions: kept }; }   // the same position three times
    }
}

struct Job { opening: Vec<Move>, players: [Player; 2], record: bool }   // players: [White, Black]

// Plays every job on `threads` threads; `weights` are the weights the players name by number
fn run_all(r: &Rules, jobs: &[Job], weights: &[Weights], threads: usize) -> Vec<Game> {
    let next = AtomicUsize::new(0);
    let done: Mutex<Vec<(usize, Game)>> = Mutex::new(Vec::with_capacity(jobs.len()));
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                let mut s = Searcher::new(r, weights[0].clone());
                let mut f = Felipe::new(r);
                let mut mine = Vec::new();
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= jobs.len() { break; }
                    let j = &jobs[i];
                    mine.push((i, play_game(r, &mut s, &mut f, &j.opening, weights, j.players, j.record)));
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
fn play_match(r: &Rules, a: &Weights, b: &Weights, games: usize, nodes: (u64, u64), threads: usize, rng: &mut Rng) -> MatchResult {
    play_between(r, &[a.clone(), b.clone()], Player::Bot(0, nodes.0), Player::Bot(1, nodes.1), games, threads, rng)
}

// The same between any two players
fn play_between(r: &Rules, weights: &[Weights], a: Player, b: Player, games: usize, threads: usize, rng: &mut Rng) -> MatchResult {
    let mut jobs = Vec::new();
    for _ in 0..games.div_ceil(2) {
        let o = opening(r, rng);
        jobs.push(Job { opening: o.clone(), players: [a, b], record: false });
        jobs.push(Job { opening: o, players: [b, a], record: false });
    }
    let games = run_all(r, &jobs, weights, threads);
    // Jobs alternate: `a` is White in the even ones
    let results: Vec<f64> = games.iter().enumerate().map(|(k, g)| if k % 2 == 0 { g.result } else { 1.0 - g.result }).collect();
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

// vs-felipe A: a match between weights file A ("start" for the untrained ones) and the port of
// Felipe Lecot's engine at --depth (its own default is 5), our bot looking at --nodes a move
pub fn vs_felipe(r: &Rules, args: &[String]) {
    let a = args.get(1).expect("vs-felipe A");
    let nodes: u64 = num(args, "nodes", 2000);
    let depth: i32 = num(args, "depth", 4);
    let games: usize = num(args, "match", 200);
    let mut rng = Rng::new(num(args, "seed", 12345));
    let t = std::time::Instant::now();
    let m = play_between(r, &[load(a).1], Player::Bot(0, nodes), Player::Felipe(depth), games, threads_of(args), &mut rng);
    println!("  {a} ({nodes} positions a move) against Felipe Lecot's engine (depth {depth}): {}, {:.0} s", m.said(), t.elapsed().as_secs_f64());
}

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
    // --opponent felipe:<depth>: part of each round's games (--share, 0.5) against the port of Felipe
    // Lecot's engine instead of itself, so the bot learns from positions another way of playing
    // leads to; and every kept round plays it (--meter games, 200), as a measure from outside
    let opponent: Option<i32> = arg(args, "opponent").and_then(|s| s.strip_prefix("felipe:")).and_then(|d| d.parse().ok());
    let share: f64 = if opponent.is_some() { num(args, "share", 0.5) } else { 0.0 };
    let meter: usize = num(args, "meter", 200);
    let learn: Vec<String> = arg(args, "learn").unwrap_or("values,shape,cells,extras").split(',').map(String::from).collect();
    let threads = threads_of(args);
    let out = arg(args, "out").unwrap_or("site/data/bot/hex.json").to_string();
    let (mut file, mut weights, mut shape) = load(if std::path::Path::new(&out).exists() { &out } else { "start" });
    let mut generation = file["generation"].as_u64().unwrap_or(0);
    let mut rng = Rng::new(num(args, "seed", 12345 + generation * 1000));
    println!("hex: generation {generation}, {threads} threads, {nodes} positions a move, learning {}", learn.join(","));
    if let Some(d) = opponent { println!("  {:.0}% of the games against Felipe Lecot's engine at depth {d}", share * 100.0); }
    let mut earlier: Vec<Vec<(Sample, f64, f64)>> = Vec::new();

    for _ in 0..generations {
        let t0 = std::time::Instant::now();
        // 1. Self-play
        // Against the opponent first (our bot White and Black in turn), then against itself
        let against = (games_per as f64 * share).round() as usize;
        let jobs: Vec<Job> = (0..games_per).map(|i| {
            let me = Player::Bot(0, nodes);
            let players = match opponent { Some(d) if i < against => if i % 2 == 0 { [me, Player::Felipe(d)] } else { [Player::Felipe(d), me] }, _ => [me, me] };
            Job { opening: opening(r, &mut rng), players, record: true }
        }).collect();
        let games = run_all(r, &jobs, &[weights.clone()], threads);
        let decided = games.iter().filter(|g| g.result != 0.5).count();
        earlier.push(games.into_iter().flat_map(|g| { let res = g.result; g.positions.into_iter().map(move |(s, sc)| (s, res, sc)) }).collect());
        if earlier.len() > keep { earlier.remove(0); }
        // Mixed, not game by game: an index list, shuffled
        let mut order: Vec<(usize, usize)> = earlier.iter().enumerate().flat_map(|(a, v)| (0..v.len()).map(move |b| (a, b))).collect();
        for i in (1..order.len()).rev() { let j = rng.below(i + 1); order.swap(i, j); }
        let data: Vec<&(Sample, f64, f64)> = order.iter().map(|&(a, b)| &earlier[a][b]).collect();
        println!("  self-play: {games_per} games ({decided} decided); learning from {} positions of the last {} round(s), {:.0} s",
            data.len(), earlier.len(), t0.elapsed().as_secs_f64());

        // 2. Learning
        let t1 = std::time::Instant::now();
        let learned = tune(r, &weights, &shape, &data, &learn, lambda);
        let show = |a: &[f64]| a[..5].iter().map(|x| format!("{x:.2}")).collect::<Vec<_>>().join(" ");
        let lw = &learned.weights;
        println!("  learning: {:.1} s, prediction error {:.5} -> {:.5}", t1.elapsed().as_secs_f64(), learned.before, learned.after);
        println!("    middle game: values {}; further up {}; middle {}", show(&lw.mid), show(&learned.shape.adv[0]), show(&learned.shape.cen[0]));
        println!("    endgame:     values {}; further up {}; middle {}", show(&lw.end), show(&learned.shape.adv[1]), show(&learned.shape.cen[1]));
        let ex = |a: &[f64; EXTRAS]| a.iter().map(|x| format!("{x:.3}")).collect::<Vec<_>>().join(" ");
        println!("    extras (mobility N B R Q K, passed, passed far, pawns by king, near enemy king): middle {} / end {}", ex(&lw.xmid), ex(&lw.xend));

        // 3. Proof
        let t2 = std::time::Instant::now();
        let m = play_match(r, &learned.weights, &weights, match_games, (nodes, nodes), threads, &mut rng);
        let kept = m.score - 2.0 * m.sd > 0.5;   // better by twice the match's margin of error
        println!("  match: new {}, {:.0} s: {}", m.said(), t2.elapsed().as_secs_f64(), if kept { "kept" } else { "not kept" });
        let mut entry = json!({
            "generation": generation + 1, "selfPlay": games_per, "positions": data.len(),
            "match": { "games": m.games, "score": (m.score * 1000.0).round() / 1000.0, "wins": m.wins, "losses": m.losses },
            "kept": kept, "trainer": "rust", "nodes": nodes, "learned": learn.join(","),
        });
        if kept {
            if baseline > 0 {
                let b = play_match(r, &learned.weights, &starting(), baseline, (nodes, nodes), threads, &mut rng);
                println!("  against the untrained bot: {}", b.said());
                entry["untrained"] = json!({ "games": b.games, "score": (b.score * 1000.0).round() / 1000.0 });
            }
            if let (Some(d), true) = (opponent, meter > 0) {
                let f = play_between(r, &[learned.weights.clone()], Player::Bot(0, nodes), Player::Felipe(d), meter, threads, &mut rng);
                println!("  against Felipe Lecot's engine (depth {d}): {}", f.said());
                entry["felipe"] = json!({ "depth": d, "games": f.games, "score": (f.score * 1000.0).round() / 1000.0 });
            }
            generation += 1;
            weights = learned.weights;
            shape = learned.shape;
            file["generation"] = json!(generation);
        }
        let history = file["history"].as_array().cloned().unwrap_or_default();
        file["history"] = Value::Array(history.into_iter().chain(std::iter::once(entry)).collect());
        store(&mut file, &weights, &shape);
        if let Some(dir) = std::path::Path::new(&out).parent() { std::fs::create_dir_all(dir).ok(); }
        std::fs::write(&out, serde_json::to_string(&file).unwrap() + "\n").expect("can't write the weights");
    }
}

// --- Learning: the bot's quick judgement fitted to targets, by gradient descent (Adam) -----------------
// What's learned, in the middle game and in the endgame alike: each kind of piece's value; how much
// better it is further up the board and nearer the middle (two numbers each, shared by every cell, so
// a few hundred games are enough); an extra for each single cell, held near nothing unless many games
// call for it (learning every cell freely from 400 games made the bot much worse: 35.5%, Nov 7); and
// what each extra (mobility, passed pawns, the king's safety) is worth. The sigmoid's scale is fitted
// first, so lots of draws can't just shrink every number.
pub struct Learned { pub weights: Weights, pub shape: Shape, pub before: f64, pub after: f64 }

fn sig(x: f64) -> f64 { 1.0 / (1.0 + (-x).exp()) }

// What's learned, as one list: [values mid 6, values end 6 | further up mid 6, middle mid 6, further
// up end 6, middle end 6 | cell extras mid 6*CELLS, end 6*CELLS | extras mid, extras end]
const VAL: usize = 0;
const SHAPE: usize = 2 * TYPES;
const CELL: usize = SHAPE + 4 * TYPES;
const EXTRA: usize = CELL + 2 * TYPES * CELLS;
const THETA: usize = EXTRA + 2 * EXTRAS;

pub fn tune(r: &Rules, w0: &Weights, shape: &Shape, data: &[&(Sample, f64, f64)], learn: &[String], lambda: f64) -> Learned {
    let info = &r.g.info;
    let mut theta = vec![0.0; THETA];
    for ph in 0..2 {
        let table = if ph == 0 { &w0.mid } else { &w0.end };
        for t in 0..TYPES {
            theta[VAL + ph * TYPES + t] = table[t];
            theta[SHAPE + (2 * ph) * TYPES + t] = shape.adv[ph][t];
            theta[SHAPE + (2 * ph + 1) * TYPES + t] = shape.cen[ph][t];
            for i in 0..CELLS {
                theta[CELL + (ph * TYPES + t) * CELLS + i] = table[TYPES + t * CELLS + i] - shape.adv[ph][t] * info[i][0] - shape.cen[ph][t] * info[i][1];
            }
        }
    }
    for k in 0..EXTRAS { theta[EXTRA + k] = w0.xmid[k]; theta[EXTRA + EXTRAS + k] = w0.xend[k]; }
    let old = theta.clone();
    let bake = |theta: &[f64], w: &mut Weights| {
        for ph in 0..2 {
            let table = if ph == 0 { &mut w.mid } else { &mut w.end };
            for t in 0..TYPES {
                table[t] = theta[VAL + ph * TYPES + t];
                let (a, c) = (theta[SHAPE + (2 * ph) * TYPES + t], theta[SHAPE + (2 * ph + 1) * TYPES + t]);
                for i in 0..CELLS { table[TYPES + t * CELLS + i] = a * info[i][0] + c * info[i][1] + theta[CELL + (ph * TYPES + t) * CELLS + i]; }
            }
        }
        for k in 0..EXTRAS { w.xmid[k] = theta[EXTRA + k]; w.xend[k] = theta[EXTRA + EXTRAS + k]; }
    };
    let mut w = w0.clone();
    bake(&theta, &mut w);
    let eval_of = |s: &Sample, w: &Weights| -> f64 {
        let (mut mg, mut eg) = (0.0, 0.0);
        for &k in &s.f { if k > 0 { mg += w.mid[(k - 1) as usize]; eg += w.end[(k - 1) as usize]; } else { mg -= w.mid[(-k - 1) as usize]; eg -= w.end[(-k - 1) as usize]; } }
        let mut e = mg * s.ph + eg * (1.0 - s.ph);
        for k in 0..EXTRAS { e += (w.xmid[k] * s.ph + w.xend[k] * (1.0 - s.ph)) * s.x[k]; }
        e
    };
    let error = |k: f64, w: &Weights, target: &dyn Fn(f64, f64) -> f64| -> f64 {
        data.iter().map(|(s, res, sc)| (target(*res, *sc) - sig(k * eval_of(s, w))).powi(2)).sum::<f64>() / data.len() as f64
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
    let group = |i: usize| if i < SHAPE { "values" } else if i < CELL { "shape" } else if i < EXTRA { "cells" } else { "extras" };
    let may: Vec<bool> = (0..THETA).map(|i| learn.iter().any(|g| g == group(i))).collect();
    let (mut m, mut v) = (vec![0.0; THETA], vec![0.0; THETA]);
    let mut step = 0;
    let (mut gmid, mut gend) = (vec![0.0; SIZE], vec![0.0; SIZE]);
    let mut gt = vec![0.0; THETA];
    for _ in 0..EPOCHS {
        let mut at = 0;
        while at < data.len() {
            let end = (at + BATCH).min(data.len());
            let n = (end - at) as f64;
            gmid.iter_mut().for_each(|x| *x = 0.0);
            gend.iter_mut().for_each(|x| *x = 0.0);
            gt.iter_mut().for_each(|x| *x = 0.0);
            for j in at..end {
                let s = &data[j].0;
                let p = sig(k * eval_of(s, &w));
                let d = 2.0 * (p - targets[j]) * p * (1.0 - p) * k / n;
                let (dm, de) = (d * s.ph, d * (1.0 - s.ph));
                for &x in &s.f {
                    if x > 0 { gmid[(x - 1) as usize] += dm; gend[(x - 1) as usize] += de; }
                    else { gmid[(-x - 1) as usize] -= dm; gend[(-x - 1) as usize] -= de; }
                }
                for q in 0..EXTRAS { gt[EXTRA + q] += dm * s.x[q]; gt[EXTRA + EXTRAS + q] += de * s.x[q]; }
            }
            for ph in 0..2 {
                let g = if ph == 0 { &gmid } else { &gend };
                for t in 0..TYPES {
                    gt[VAL + ph * TYPES + t] = g[t];
                    for i in 0..CELLS {
                        let gc = g[TYPES + t * CELLS + i];
                        gt[SHAPE + (2 * ph) * TYPES + t] += gc * info[i][0];
                        gt[SHAPE + (2 * ph + 1) * TYPES + t] += gc * info[i][1];
                        gt[CELL + (ph * TYPES + t) * CELLS + i] = gc;
                    }
                }
            }
            step += 1;
            for i in 0..THETA {
                if !may[i] { continue; }
                let pull = if (CELL..EXTRA).contains(&i) { 2.0 * HOLD * theta[i] } else { 2.0 * PULL * (theta[i] - old[i]) };
                let gk = gt[i] + pull;
                m[i] = 0.9 * m[i] + 0.1 * gk;
                v[i] = 0.999 * v[i] + 0.001 * gk * gk;
                theta[i] -= RATE * (m[i] / (1.0 - 0.9f64.powi(step))) / ((v[i] / (1.0 - 0.999f64.powi(step))).sqrt() + 1e-8);
            }
            theta[VAL + 5] = 0.0;           // the king's value: both sides always have one
            theta[VAL + TYPES + 5] = 0.0;
            bake(&theta, &mut w);
            at = end;
        }
    }
    let after = error(k, &w, &target);
    let six = |from: usize| -> [f64; TYPES] { theta[from..from + TYPES].try_into().unwrap() };
    let shape = Shape { adv: [six(SHAPE), six(SHAPE + 2 * TYPES)], cen: [six(SHAPE + TYPES), six(SHAPE + 3 * TYPES)] };
    Learned { weights: w, shape, before, after }
}
