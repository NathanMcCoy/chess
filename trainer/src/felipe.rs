// A Rust port of Felipe Lecot's Hex Chess Engine (github.com/FelipeLecot/Hex-Chess-Engine, MIT
// licence, the notice is in trainer/LICENSE-felipe-hex-chess-engine; ported from commit f0368a8),
// as a sparring partner for our bot: the same choices, many times faster.
//
// What's ported exactly: its search (search.c: alpha-beta to a fixed depth, deepened one step at
// a time as its UCI `go depth` does, no following of captures at the end, its mate scores), its
// table of positions (tt.c: 2^17 entries, always replaced, kept between moves and games), its move
// order (movegen.c's order of generating moves, evaluatemove.c's scores and picking, quirks
// included: a remembered best move scores 1000, below big captures; any move onto the en passant
// cell scores as en passant), and its judgement (evaluation.c: material and piece-square tables
// from cube coordinates, Black's made by turning White's 180 degrees, as it does). Inside its
// search a stalemate is a draw (0) and there's no fifty-move rule or repetition, as in board.c.
//
// What isn't: its move generator. Moves come from our rules (hex.rs, checked against hex.js), so
// it can only play legal moves by our rules. They're the same as its own except in rare en passant
// positions: it removes the first enemy pawn next to the en passant cell (not always the one that
// moved two), and treats any pawn move onto that cell as en passant. Its position keys are its own
// random numbers, so which entries of the table collide differs; the original's do too, run to run.
use crate::hex::*;

pub const MAX_EVAL: i32 = 1_000_000;
const MIN_EVAL: i32 = -MAX_EVAL;
const TT_SIZE: usize = 1 << 17;

// Its piece order: PAWN_W..KING_W = 0..5, PAWN_B..KING_B = 6..11
const PIECE_VALUES: [i32; 6] = [100, 320, 330, 500, 900, 20000];
const KNIGHT_DIST: [i32; 6] = [30, 20, 10, 0, -15, -30];
const BISHOP_DIST: [i32; 6] = [20, 12, 6, 0, -5, -10];
const QUEEN_DIST: [i32; 6] = [10, 5, 2, 0, 0, 0];
const KING_DIST: [i32; 6] = [-40, -20, -5, 5, 15, 20];
const VICTIM_VALUES: [i32; 6] = [100 * 16, 320 * 16, 330 * 16, 500 * 16, 900 * 16, 20000 * 16];
const MAX_MOVE_SCORE: i32 = 1000;
const PAWN_EXCHANGE: i32 = 100 * 16 - 100;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Node { Exact, Lower, Upper }

#[derive(Clone, Copy)]
struct Entry { key: u64, eval: i32, node: Node, depth: i32, mv: (u8, u8, u8) }   // (from, to, promotion kind or 0)
impl Default for Entry { fn default() -> Self { Entry { key: 0, eval: 0, node: Node::Exact, depth: 0, mv: (0, 0, 0) } } }

// One of its moves: ours, with its score and whether it's been tried
#[derive(Clone, Copy)]
struct Scored { m: Move, score: i32, tried: bool }

pub struct Felipe<'a> {
    r: &'a Rules,
    pst: [[[i32; CELLS]; 6]; 2],   // [White, Black][kind][cell], with its signs: Black's negative
    table: Vec<Entry>,
    nodes: u64,
    max_depth: i32,
    best: Option<Move>,
    scratch: Vec<Move>,
}

pub struct Choice { pub mv: Option<Move>, pub score: i32, pub depth: i32, pub nodes: u64 }

impl<'a> Felipe<'a> {
    pub fn new(r: &'a Rules) -> Felipe<'a> {
        // Its cube coordinates (q, r, s) are ours with r and s swapped (hex.rs's r grows down a file,
        // its r up), and it numbers the cells in the same order, with the same names
        let g = &r.g;
        let theirs = |i: usize| -> (i32, i32, i32) { (g.q[i], -g.q[i] - g.r[i], g.r[i]) };
        let index_of = |q: i32, rr: i32| -> usize { (0..CELLS).find(|&j| theirs(j).0 == q && theirs(j).1 == rr).unwrap() };
        let mut pst = [[[0i32; CELLS]; 6]; 2];
        for sq in 0..CELLS {
            let (q, rr, s) = theirs(sq);
            let dist = ((q.abs() + rr.abs() + s.abs()) / 2) as usize;
            pst[0][0][sq] = rr * 8 + (5 - q.abs()) * 3;
            pst[0][1][sq] = KNIGHT_DIST[dist];
            pst[0][2][sq] = BISHOP_DIST[dist];
            pst[0][3][sq] = rr * 2 + (5 - q.abs()) * 2;
            pst[0][4][sq] = QUEEN_DIST[dist];
            pst[0][5][sq] = KING_DIST[dist];
        }
        for t in 0..6 {
            for sq in 0..CELLS {
                let (q, rr, _) = theirs(sq);
                pst[1][t][sq] = -pst[0][t][index_of(-q, -rr)];   // turned 180 degrees, negated
            }
        }
        Felipe { r, pst, table: vec![Entry::default(); TT_SIZE], nodes: 0, max_depth: 0, best: None, scratch: Vec::with_capacity(128) }
    }

    // A fresh table, as a new run of the original starts with (it keeps it between `go`s, even games)
    pub fn clear(&mut self) { self.table.iter_mut().for_each(|e| *e = Entry::default()); }

    // White's view, in centipawns (evaluation.c)
    pub fn evaluate(&self, p: &Pos) -> i32 {
        let mut score = 0;
        for sq in 0..CELLS {
            let pc = p.board[sq];
            if pc == 0 { continue; }
            let t = (kind(pc) - 1) as usize;
            if side(pc) == 0 { score += PIECE_VALUES[t] + self.pst[0][t][sq]; } else { score += -PIECE_VALUES[t] + self.pst[1][t][sq]; }
        }
        score
    }

    // Its order of generating moves (movegen.c): pawns, knights, bishops, rooks, queens, king, each
    // kind by cell; a pawn's push (promotions Q R B N), its double push, then its two captures in its
    // direction order; other pieces' moves by destination cell
    fn order_key(&self, p: &Pos, m: &Move) -> (u8, u8, u16) {
        let g = &self.r.g;
        let k = kind(p.board[m.from as usize]);
        let rank = [0u8, 0, 1, 2, 3, 4, 5][k as usize];   // P N B R Q K
        let promo = match m.promo { QUEEN => 0, ROOK => 1, BISHOP => 2, KNIGHT => 3, _ => 0 };
        let sub: u16 = if k == PAWN {
            let s = p.turn as usize;
            let from = m.from as usize;
            // Its capture directions, in hex.rs's terms: White's first is our second, Black's our first
            let caps = if s == 0 { [g.pawn_captures[0][1][from], g.pawn_captures[0][0][from]] } else { [g.pawn_captures[1][0][from], g.pawn_captures[1][1][from]] };
            if caps[0] == m.to as i16 { 200 + promo } else if caps[1] == m.to as i16 { 300 + promo }
            else if m.double >= 0 { 100 } else { promo }
        } else { m.to as u16 };
        (rank, m.from, sub)
    }

    fn piece_index(p: &Pos, sq: usize) -> usize { let pc = p.board[sq]; (kind(pc) - 1) as usize + if side(pc) == 0 { 0 } else { 6 } }

    // evaluatemove.c's score_moves
    fn score(&self, p: &Pos, entry: &Entry, list: &mut [Scored]) {
        let pv = if entry.key == p.hash && entry.node != Node::Upper { Some(entry.mv) } else { None };
        for s in list.iter_mut() {
            let m = &s.m;
            if pv == Some((m.from, m.to, m.promo)) { s.score = MAX_MOVE_SCORE; continue; }
            let to = m.to as usize;
            let enemy = p.board[to] != 0 && side(p.board[to]) != p.turn;
            s.score = if p.ep == m.to as i16 { PAWN_EXCHANGE }
                else if enemy { VICTIM_VALUES[(kind(p.board[to]) - 1) as usize] - PIECE_VALUES[Self::piece_index(p, m.from as usize) % 6] }
                else { 0 };
        }
    }

    // evaluatemove.c's select_move: the highest score above -1, the first of equals; then any untried
    fn select(list: &mut [Scored]) -> Option<usize> {
        let mut best: Option<usize> = None;
        let mut best_score = -1;
        for (i, s) in list.iter().enumerate() { if !s.tried && s.score > best_score { best_score = s.score; best = Some(i); } }
        if best.is_none() { best = list.iter().position(|s| !s.tried); }
        if let Some(i) = best { list[i].tried = true; }
        best
    }

    // board.c's result: too few pieces is a draw (before anything else), no moves is mate or (as it
    // scores it) a draw
    fn result(&self, p: &Pos, moves: usize) -> Option<i32> {   // Some(White's result: 1, -1, 0)
        if p.majors == 0 && p.minors <= 1 { return Some(0); }
        if moves > 0 { return None; }
        if self.r.in_check(p) { return Some(if p.turn == 0 { -1 } else { 1 }); }
        Some(0)
    }

    fn alphabeta(&mut self, p: &Pos, depth: i32, mut alpha: i32, mut beta: i32) -> i32 {
        self.nodes += 1;
        let orig_alpha = alpha;
        let slot = (p.hash as usize) & (TT_SIZE - 1);
        let entry = self.table[slot];
        let at_root = depth == self.max_depth;
        let entry_move = |p: &Pos, e: &Entry, r: &Rules, scratch: &mut Vec<Move>| -> Option<Move> {
            let mut list = Vec::new();
            r.legal(p, &mut list, scratch);
            list.into_iter().find(|m| (m.from, m.to, m.promo) == e.mv)
        };
        if entry.key == p.hash && entry.depth >= depth {
            match entry.node {
                Node::Exact => { if at_root { self.best = entry_move(p, &entry, self.r, &mut self.scratch); } return entry.eval; }
                Node::Lower => alpha = alpha.max(entry.eval),
                Node::Upper => beta = beta.min(entry.eval),
            }
            if alpha >= beta { if at_root { self.best = entry_move(p, &entry, self.r, &mut self.scratch); } return entry.eval; }
        }
        let mut legal = Vec::new();
        self.r.legal(p, &mut legal, &mut self.scratch);
        let sign = if p.turn == 0 { 1 } else { -1 };   // its WHITE is 1: evaluations are White's, turned to the mover's
        if let Some(res) = self.result(p, legal.len()) {
            let mut eval = match res { 1 => MAX_EVAL, -1 => MIN_EVAL, _ => 0 };
            if res != 0 { eval += (self.max_depth - depth) * sign; }
            return eval * sign;
        }
        if depth == 0 { return self.evaluate(p) * sign; }

        legal.sort_by_key(|m| self.order_key(p, m));
        let mut list: Vec<Scored> = legal.into_iter().map(|m| Scored { m, score: 0, tried: false }).collect();
        self.score(p, &entry, &mut list);

        let mut eval = MIN_EVAL;
        let mut best: Option<Move> = None;
        while let Some(i) = Self::select(&mut list) {
            let m = list[i].m;
            let child = self.r.play(p, &m);
            let child_eval = -self.alphabeta(&child, depth - 1, -beta, -alpha);
            if child_eval > eval {
                eval = child_eval;
                best = Some(m);
                if at_root { self.best = best; }
            }
            alpha = alpha.max(child_eval);
            if alpha >= beta { break; }
        }
        // tt.c's addTTEntry, called with (beta, origAlpha): upper at or below alpha, lower at or above beta
        let node = if eval <= orig_alpha { Node::Upper } else if eval >= beta { Node::Lower } else { Node::Exact };
        let mv = best.map(|m| (m.from, m.to, m.promo)).unwrap_or((0, 0, 0));
        self.table[slot] = Entry { key: p.hash, eval, node, depth, mv };
        eval
    }

    // uci.c's `go depth N`: depths 1 to N in turn, each warming the table for the next; the move is
    // the last depth's
    pub fn choose(&mut self, p: &Pos, depth: i32) -> Choice {
        let mut score = 0;
        let mut nodes = 0;
        for d in 1..=depth.max(1) {
            self.best = None;
            self.nodes = 0;
            self.max_depth = d;
            score = self.alphabeta(p, d, MIN_EVAL, MAX_EVAL);
            nodes += self.nodes;
        }
        Choice { mv: self.best, score, depth, nodes }
    }
}
