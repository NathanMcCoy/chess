// The bot's search and judgement, as in site/js/bot/bot.js (the same scores: pawns, from the side to
// move's point of view; mate MATE less the moves to it; Gliński's ¾ stalemate ±STALEMATE; a position
// met before 0), with better move ordering (killer moves and a history table), so the same number of
// positions looked at reaches further. A move is limited by positions looked at, not time, so a busy
// machine doesn't change the games.
use crate::hex::*;

pub const MATE: f64 = 1000.0;
const STALEMATE: f64 = 5.0;
const QUIET_PLY: usize = 32;
const CHECK_PLY: usize = 16;
const MAX_PLY: usize = 128;
pub const TYPES: usize = 6;

// --- The judgement --------------------------------------------------------------------------------
// As bot.js: for the middle game (mid) and the endgame (end), the six piece values then each kind's
// value on each cell from its own side; and what each of the extras is worth in each. The two are
// blended by the phase.
#[derive(Clone)]
pub struct Weights { pub mid: Vec<f64>, pub end: Vec<f64>, pub xmid: [f64; EXTRAS], pub xend: [f64; EXTRAS] }
impl Weights {
    // The untrained weights: the usual piece values, nothing else
    pub fn starting() -> Weights {
        let mut v = vec![0.0; TYPES * (1 + CELLS)];
        for (k, x) in [1.0, 3.0, 3.0, 5.0, 9.0].iter().enumerate() { v[k] = *x; }
        Weights { mid: v.clone(), end: v, xmid: [0.0; EXTRAS], xend: [0.0; EXTRAS] }
    }
    fn has_extras(&self) -> bool { self.xmid.iter().chain(self.xend.iter()).any(|&x| x != 0.0) }
}

// How good the position is for White, in pawns: added up in the same order as bot.js
#[inline]
pub fn evaluate(r: &Rules, p: &Pos, w: &Weights) -> f64 {
    let (mut mg, mut eg) = (0.0, 0.0);
    for i in 0..CELLS {
        let pc = p.board[i];
        if pc == 0 { continue; }
        let k = (kind(pc) - 1) as usize;
        let white = side(pc) == 0;
        let at = TYPES + k * CELLS + if white { i } else { r.g.mirror[i] as usize };
        let s = if white { 1.0 } else { -1.0 };
        mg += s * (w.mid[k] + w.mid[at]);
        eg += s * (w.end[k] + w.end[at]);
    }
    let ph = r.phase(p);
    let mut score = mg * ph + eg * (1.0 - ph);
    if w.has_extras() {
        let x = r.extras(p);
        for k in 0..EXTRAS { score += (w.xmid[k] * ph + w.xend[k] * (1.0 - ph)) * x[k]; }
    }
    score
}

// What training needs of a position: each weight counted (index + 1, negative for Black's), the
// phase, and the extras
pub struct Sample { pub f: Vec<i32>, pub ph: f64, pub x: [f64; EXTRAS] }
pub fn sample(r: &Rules, p: &Pos) -> Sample {
    let mut f = Vec::with_capacity(72);
    for i in 0..CELLS {
        let pc = p.board[i];
        if pc == 0 { continue; }
        let k = (kind(pc) - 1) as usize;
        let white = side(pc) == 0;
        let cell = if white { i } else { r.g.mirror[i] as usize };
        let s = if white { 1 } else { -1 };
        f.push(s * (k as i32 + 1));
        f.push(s * ((TYPES + k * CELLS + cell) as i32 + 1));
    }
    Sample { f, ph: r.phase(p), x: r.extras(p) }
}

// --- The table of positions already worked out ----------------------------------------------------------
#[derive(Clone, Copy, Default)]
struct Entry { key: u64, stamp: u32, depth: i8, flag: i8, score: f32, best: u16 }
const TABLE_BITS: usize = 18;

pub struct Searcher<'a> {
    r: &'a Rules,
    w: Weights,
    net: Option<std::sync::Arc<crate::nn::Net>>,   // when set, it judges positions instead of the weights
    accs: Vec<crate::nn::Acc>,   // with a network: its first layer at each step of the line being looked at
    table: Vec<Entry>,
    stamp: u32,
    nodes: u64,
    limit: u64,
    clock: Option<(fn() -> f64, f64)>,   // in the browser: a clock (milliseconds) and when to stop by it
    stopped: bool,
    killers: [[u16; 2]; MAX_PLY],
    history: Vec<i32>,     // [from * CELLS + to]
    path: Vec<u64>,
    moves: Vec<Vec<Move>>, // one list per ply, reused
    scratch: Vec<Move>,
    pub seen: Seen,   // every earlier position in the game
    exclude: Vec<u16>,   // first moves not to consider (lines(): the best ones already found)
    pub features: u32,   // which of PVS, NULL_MOVE and LMR the search uses (Searcher::new: DEFAULT_FEATURES)
    null_at: Vec<bool>,  // the move into ply i was a pass (a null move): no second one straight after
}

// Search refinements, each switchable so a match can show what it's worth (trainer net-match
// --features A --features-b B): principal variation search, null-move pruning, late move reductions
pub const PVS: u32 = 1;
pub const NULL_MOVE: u32 = 2;
pub const LMR: u32 = 4;
// All three (Nov 8): 62.4% +- 2.1 against none at 200,000 positions a move (level at 20,000:
// reductions pay off in deeper searches); PVS and LMR alone 60.6%
pub const DEFAULT_FEATURES: u32 = PVS | NULL_MOVE | LMR;
const EPS: f64 = 0.001;   // a "null window": just above alpha, in pawns

// One of the best lines from a position: its first move's score (pawns, for the side to move; mate
// MATE less the plies to it), how deep it was searched, and the moves (from the position table)
pub struct Line { pub score: f64, pub depth: u32, pub moves: Vec<Move> }

// A set of position hashes. They're random already, so they're used as they are: Rust's usual
// hashing is built to resist attacks, and was a noticeable cost here
#[derive(Default)]
pub struct Plain(u64);
impl std::hash::Hasher for Plain {
    fn finish(&self) -> u64 { self.0 }
    fn write(&mut self, _: &[u8]) { unreachable!("only u64 keys") }
    fn write_u64(&mut self, x: u64) { self.0 = x; }
}
pub type Seen = std::collections::HashSet<u64, std::hash::BuildHasherDefault<Plain>>;

pub struct Choice { pub mv: Option<Move>, pub score: f64, pub depth: u32, pub nodes: u64 }

#[inline] fn code(m: &Move) -> u16 { (m.from as u16) * CELLS as u16 + m.to as u16 + if m.promo != 0 { 10000 + m.promo as u16 } else { 0 } }
const VALUE: [i32; 7] = [0, 1, 3, 3, 5, 9, 0];

impl<'a> Searcher<'a> {
    pub fn new(r: &'a Rules, w: Weights) -> Searcher<'a> {
        Searcher {
            r, w, table: vec![Entry::default(); 1 << TABLE_BITS], stamp: 0, nodes: 0, limit: 0, clock: None, net: None, stopped: false,
            killers: [[u16::MAX; 2]; MAX_PLY], history: vec![0; CELLS * CELLS], path: Vec::new(),
            moves: (0..MAX_PLY + 8).map(|_| Vec::with_capacity(128)).collect(), scratch: Vec::with_capacity(128),
            seen: Seen::default(), accs: vec![crate::nn::Acc::default(); MAX_PLY + 8], exclude: Vec::new(),
            features: DEFAULT_FEATURES, null_at: vec![false; MAX_PLY + 8],
        }
    }

    // The best `count` lines from `root`, for the game review: the best move, then the best of the
    // rest, and so on, each searched for `ms` milliseconds by `now`. Fewer if there are fewer moves.
    pub fn lines(&mut self, root: &Pos, count: usize, ms: f64, now: fn() -> f64) -> Vec<Line> {
        let mut out: Vec<Line> = Vec::new();
        self.exclude.clear();
        for _ in 0..count {
            let c = self.choose_timed(root, ms, now);
            let Some(m) = c.mv else { break };
            let moves = self.pv(root, &m, 12);
            out.push(Line { score: c.score, depth: c.depth, moves });
            self.exclude.push(code(&m));
        }
        self.exclude.clear();
        out
    }

    // A line starting with move `first` from `root`: then each position's best move as the last
    // search left it in the table, while there is one (and the line doesn't come back on itself)
    pub fn pv(&mut self, root: &Pos, first: &Move, max: usize) -> Vec<Move> {
        let mut line = vec![*first];
        let mut p = self.r.play(root, first);
        let mut been = vec![root.hash, p.hash];
        let mut list = Vec::new();
        while line.len() < max {
            let e = self.table[(p.hash as usize) & ((1 << TABLE_BITS) - 1)];
            if e.key != p.hash || e.stamp != self.stamp || e.best == u16::MAX { break; }
            self.r.legal(&p, &mut list, &mut self.scratch);
            let Some(m) = list.iter().find(|m| code(m) == e.best).copied() else { break };
            p = self.r.play(&p, &m);
            if been.contains(&p.hash) { break; }
            been.push(p.hash);
            line.push(m);
        }
        line
    }

    // Before looking at move m in position p (at step `ply` of the line): the network's first layer
    // for the position after it, from p's, changed only by what m changes
    #[inline]
    fn descend(&mut self, p: &Pos, m: &Move, ply: usize) {
        if let Some(net) = &self.net {
            let (lo, hi) = self.accs.split_at_mut(ply + 1);
            net.update(self.r, p, m, &lo[ply], &mut hi[0]);
        }
    }
    pub fn set_weights(&mut self, w: &Weights) { self.w = w.clone(); }
    pub fn set_net(&mut self, net: Option<std::sync::Arc<crate::nn::Net>>) { self.net = net; }

    fn judge(&self, p: &Pos, ply: usize) -> f64 {
        if let Some(net) = &self.net { return net.output(&self.accs[ply], p.turn) as f64; }   // already for the side to move
        let s = evaluate(self.r, p, &self.w);
        if p.turn == 0 { s } else { -s }
    }

    fn terminal(&self, p: &Pos, ply: usize) -> f64 {
        if self.r.in_check(p) { return -(MATE - ply as f64); }
        // Gliński's stalemate: ¾ to the side giving it; the side to move has ¼
        (0.25 - 0.5) * 4.0 * STALEMATE
    }

    #[inline]
    fn tick(&mut self) -> bool {
        self.nodes += 1;
        if self.nodes >= self.limit { self.stopped = true; }
        if self.nodes & 1023 == 0 { if let Some((now, deadline)) = self.clock { if now() >= deadline { self.stopped = true; } } }
        self.stopped
    }

    fn rank(&self, p: &Pos, m: &Move, best: u16, ply: usize) -> i32 {
        let c = code(m);
        if c == best { return 1 << 30; }
        let mut s = 0;
        if m.captured != 0 { s += (1 << 20) + 10 * VALUE[m.captured as usize] - VALUE[kind(p.board[m.from as usize]) as usize]; }
        if m.promo != 0 { s += (1 << 19) + VALUE[m.promo as usize]; }
        if s == 0 {
            if ply < MAX_PLY && (self.killers[ply][0] == c || self.killers[ply][1] == c) { return 1 << 18; }
            return self.history[m.from as usize * CELLS + m.to as usize].min((1 << 18) - 1);
        }
        s
    }

    // Best first; moves ranked equal keep their order. An insertion sort on the stack: the lists are
    // short, and sort_by_cached_key took memory from the heap at every position (Nov 8: +3.5%)
    fn order(&self, p: &Pos, list: &mut [Move], best: u16, ply: usize) {
        const MAX: usize = 256;
        if list.len() > MAX { list.sort_by_cached_key(|m| std::cmp::Reverse(self.rank(p, m, best, ply))); return; }
        let mut keys = [0i32; MAX];
        for (k, m) in keys.iter_mut().zip(list.iter()) { *k = self.rank(p, m, best, ply); }
        for i in 1..list.len() {
            let (k, m) = (keys[i], list[i]);
            let mut j = i;
            while j > 0 && keys[j - 1] < k { keys[j] = keys[j - 1]; list[j] = list[j - 1]; j -= 1; }
            keys[j] = k;
            list[j] = m;
        }
    }

    fn quiet(&mut self, p: &Pos, mut alpha: f64, beta: f64, ply: usize) -> f64 {
        if self.tick() { return 0.0; }
        let mut list = std::mem::take(&mut self.moves[ply]);
        let result = 'out: {
            // As bot.js: no moves at all is mate or stalemate, then a draw, then the position's value;
            // but only the captures are listed in full, the rest only until one legal move is found
            if !self.r.legal_captures(p, &mut list, &mut self.scratch) { break 'out self.terminal(p, ply); }
            if self.r.drawn(p) { break 'out 0.0; }
            let stand = self.judge(p, ply);
            if stand >= beta || ply >= QUIET_PLY { break 'out stand; }   // as bot.js: QUIET_PLY moves from the root
            if stand > alpha { alpha = stand; }
            self.order(p, &mut list, u16::MAX, MAX_PLY);
            for m in list.iter() {
                self.descend(p, m, ply);
                let child = self.r.play(p, m);
                let score = -self.quiet(&child, -beta, -alpha, ply + 1);
                if self.stopped { break 'out 0.0; }
                if score >= beta { break 'out score; }
                if score > alpha { alpha = score; }
            }
            alpha
        };
        self.moves[ply] = list;
        result
    }

    fn search(&mut self, p: &Pos, mut depth: i32, mut alpha: f64, beta: f64, ply: usize) -> f64 {
        if self.tick() { return 0.0; }
        if ply > 0 && (self.path.contains(&p.hash) || self.seen.contains(&p.hash)) { return 0.0; }
        if self.r.drawn(p) { return 0.0; }
        let in_check = self.r.in_check(p);
        if in_check && ply < CHECK_PLY { depth += 1; }
        // At the end of the line, the captures-only search (which finds mate and stalemate itself);
        // and a position already worked out deeply enough is answered from the table. Both before
        // listing the moves: most positions are one or the other, and the list would go unused
        if depth <= 0 || ply >= MAX_PLY - 1 { return self.quiet(p, alpha, beta, ply); }
        let slot = (p.hash as usize) & ((1 << TABLE_BITS) - 1);
        let known = self.table[slot];
        let mut best_code = u16::MAX;
        if known.key == p.hash && known.stamp == self.stamp {
            best_code = known.best;
            if known.depth as i32 >= depth {
                let s = known.score as f64;
                if known.flag == 0 || (known.flag < 0 && s <= alpha) || (known.flag > 0 && s >= beta) { return s; }
            }
        }
        // Null move (NULL_MOVE): if passing would still leave this side at or above beta, a real
        // move will too. Not in check, not twice running, not with only pawns left (zugzwang: a
        // stalemate scores ¾ in Gliński's chess), not near mate scores
        if self.features & NULL_MOVE != 0 && !in_check && depth >= 3 && ply > 0 && !self.null_at[ply]
            && beta.abs() < MATE - 100.0 && self.r.has_pieces(p) && self.judge(p, ply) >= beta {
            let reduce = 2 + depth / 4;
            let child = self.r.null_move(p);
            if self.net.is_some() { self.accs[ply + 1] = self.accs[ply]; }   // the same pieces
            self.null_at[ply + 1] = true;
            self.path.push(p.hash);
            let score = -self.search(&child, depth - 1 - reduce, -beta, -beta + EPS, ply + 1);
            self.path.pop();
            self.null_at[ply + 1] = false;
            if self.stopped { return 0.0; }
            if score >= beta { return if score > MATE - 100.0 { beta } else { score }; }
        }
        let mut list = std::mem::take(&mut self.moves[ply]);
        self.r.legal(p, &mut list, &mut self.scratch);
        if list.is_empty() { self.moves[ply] = list; return self.terminal(p, ply); }
        let start = alpha;
        let mut best = f64::NEG_INFINITY;
        let mut best_move = u16::MAX;
        self.order(p, &mut list, best_code, ply);
        self.path.push(p.hash);
        for (i, m) in list.iter().enumerate() {
            self.descend(p, m, ply);
            let child = self.r.play(p, m);
            let score = if self.features & PVS == 0 || i == 0 {
                -self.search(&child, depth - 1, -beta, -alpha, ply + 1)
            } else {
                // PVS: is this move better than the best so far? Asked with a window just above alpha
                // (cheap), and searched in full only if so. LMR: late quiet moves are first asked a
                // ply or two shallower, and again at full depth if they turn out better
                let c = code(m);
                let late = self.features & LMR != 0 && depth >= 3 && i >= 3 && !in_check && m.captured == 0 && m.promo == 0
                    && self.killers[ply][0] != c && self.killers[ply][1] != c && !self.r.in_check(&child);
                let reduce = if !late { 0 } else if i >= 8 && depth >= 5 { 2 } else { 1 };
                let mut s = -self.search(&child, depth - 1 - reduce, -alpha - EPS, -alpha, ply + 1);
                if !self.stopped && s > alpha && reduce > 0 { s = -self.search(&child, depth - 1, -alpha - EPS, -alpha, ply + 1); }
                if !self.stopped && s > alpha && s < beta { s = -self.search(&child, depth - 1, -beta, -alpha, ply + 1); }
                s
            };
            if self.stopped { break; }
            if score > best { best = score; best_move = code(m); }
            if score > alpha { alpha = score; }
            if alpha >= beta {
                if m.captured == 0 && m.promo == 0 {   // a quiet move that refuted this line: try it early elsewhere
                    let c = code(m);
                    if self.killers[ply][0] != c { self.killers[ply][1] = self.killers[ply][0]; self.killers[ply][0] = c; }
                    let h = &mut self.history[m.from as usize * CELLS + m.to as usize];
                    *h = (*h + depth * depth).min(1 << 17);
                }
                break;
            }
        }
        self.path.pop();
        self.moves[ply] = list;
        if self.stopped { return 0.0; }
        let flag = if best <= start { -1 } else if best >= beta { 1 } else { 0 };
        self.table[slot] = Entry { key: p.hash, stamp: self.stamp, depth: depth as i8, flag, score: best as f32, best: best_move };
        best
    }

    // A move in about `ms` milliseconds by the clock `now` (in the browser, where bot.js would use its time)
    pub fn choose_timed(&mut self, root: &Pos, ms: f64, now: fn() -> f64) -> Choice {
        self.clock = Some((now, now() + ms));
        let c = self.choose(root, u64::MAX);
        self.clock = None;
        c
    }

    // A move for the side to move in `root`, looking at about `limit` positions
    pub fn choose(&mut self, root: &Pos, limit: u64) -> Choice {
        self.stamp = self.stamp.wrapping_add(1);   // forget the last move's table (as bot.js starts a new one)
        self.nodes = 0;
        self.limit = limit;
        self.stopped = false;
        self.killers = [[u16::MAX; 2]; MAX_PLY];
        self.null_at.iter_mut().for_each(|x| *x = false);
        for h in self.history.iter_mut() { *h /= 8; }
        let mut root_moves = Vec::new();
        self.r.legal(root, &mut root_moves, &mut self.scratch);
        if root_moves.is_empty() { return Choice { mv: None, score: self.terminal(root, 0), depth: 0, nodes: 0 }; }
        if !self.exclude.is_empty() {
            let ex = &self.exclude;
            root_moves.retain(|m| !ex.contains(&code(m)));
            if root_moves.is_empty() { return Choice { mv: None, score: f64::NEG_INFINITY, depth: 0, nodes: 0 }; }
        }
        self.order(root, &mut root_moves, u16::MAX, 0);
        if let Some(net) = &self.net { net.refresh(self.r, root, &mut self.accs[0]); }   // the root's, from every piece
        let mut result = Choice { mv: Some(root_moves[0]), score: 0.0, depth: 0, nodes: 0 };
        for depth in 1..64 {
            let mut alpha = f64::NEG_INFINITY;
            let mut best: Option<Move> = None;
            let prev = result.mv.map(|m| code(&m)).unwrap_or(u16::MAX);
            self.order(root, &mut root_moves, prev, 0);
            self.path.clear();
            self.path.push(root.hash);
            for (i, m) in root_moves.clone().iter().enumerate() {
                self.descend(root, m, 0);
                let child = self.r.play(root, m);
                let mut score;
                if self.features & PVS != 0 && i > 0 {
                    score = -self.search(&child, depth - 1, -alpha - EPS, -alpha, 1);
                    if !self.stopped && score > alpha { score = -self.search(&child, depth - 1, f64::NEG_INFINITY, -alpha, 1); }
                } else {
                    score = -self.search(&child, depth - 1, f64::NEG_INFINITY, -alpha, 1);
                }
                if self.stopped { break; }
                if score > alpha { alpha = score; best = Some(*m); }
            }
            if self.stopped { break; }   // a round cut short is thrown away
            result = Choice { mv: best, score: alpha, depth: depth as u32, nodes: self.nodes };
            if alpha.abs() > MATE - 100.0 { break; }
        }
        result.nodes = self.nodes;
        result
    }
}
