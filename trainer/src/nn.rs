// The bot's neural network for hex, as nn/train.py trains it (see there for what it is): its
// judgement of a position, in pawns for the side to move. tests/nn.test.mjs checks it gives what
// PyTorch gave for the same positions.
//
// The weights come as one list of numbers, in this order (nn/train.py writes them as JSON, and the
// trainer reads that): layer 1 [input][ACC] (a piece adds its input's row), its biases [ACC];
// layer 2 [32][2 ACC], [32]; layer 3 [32][32], [32]; layer 4 [32], [1]; then the shortcut's value
// for each input [INPUTS] (added up for each point of view; the side to move's less the other's,
// halved, goes straight to the output: see nn/train.py).
// Each position's first layer is worked out afresh (not kept up as pieces move): simpler, slower.
use crate::hex::*;

pub const KINDS: usize = 6;
pub const INPUTS: usize = 2 * KINDS * CELLS;
const H: usize = 32;
pub const MAX_ACC: usize = 256;   // the largest first layer (each point of view) this works with

// The first layer's numbers for both points of view (White's, Black's), and the shortcut's totals:
// the search keeps one for each step of the line it's looking at, and changes it only by what each
// move changes, rather than adding up every piece again in every position
#[derive(Clone, Copy)]
pub struct Acc { pub v: [[f32; MAX_ACC]; 2], pub short: [f32; 2] }
impl Default for Acc { fn default() -> Self { Acc { v: [[0.0; MAX_ACC]; 2], short: [0.0; 2] } } }

pub struct Net { acc: usize, l1w: Vec<f32>, l1b: Vec<f32>, l2w: Vec<f32>, l2b: Vec<f32>, l3w: Vec<f32>, l3b: Vec<f32>, l4w: Vec<f32>, l4b: f32, psqt: Vec<f32> }

impl Net {
    pub fn numbers(acc: usize) -> usize { INPUTS * acc + acc + H * 2 * acc + H + H * H + H + H + 1 + INPUTS }

    pub fn from_numbers(acc: usize, x: &[f32]) -> Option<Net> {
        if acc > MAX_ACC || x.len() != Self::numbers(acc) { return None; }
        let mut at = 0;
        let mut take = |n: usize| { let s = x[at..at + n].to_vec(); at += n; s };
        let l1w = take(INPUTS * acc);
        let l1b = take(acc);
        let l2w = take(H * 2 * acc);
        let l2b = take(H);
        let l3w = take(H * H);
        let l3b = take(H);
        let l4w = take(H);
        let l4b = take(1)[0];
        let psqt = take(INPUTS);
        Some(Net { acc, l1w, l1b, l2w, l2b, l3w, l3b, l4w, l4b, psqt })
    }

    // How good the position is for the side to move, in pawns (the first layer worked out afresh)
    pub fn evaluate(&self, r: &Rules, p: &Pos) -> f32 {
        let mut acc = Acc::default();
        self.refresh(r, p, &mut acc);
        self.output(&acc, p.turn)
    }

    // The input a piece on a cell is, from point of view v (0 White's, 1 Black's)
    #[inline]
    fn input(r: &Rules, v: usize, pc: u8, cell: usize) -> usize {
        let theirs = (side(pc) as usize != v) as usize;
        let c = if v == 0 { cell } else { r.g.mirror[cell] as usize };
        theirs * KINDS * CELLS + (kind(pc) - 1) as usize * CELLS + c
    }

    // A piece arriving on (sign 1) or leaving (sign -1) a cell, in both points of view
    #[inline]
    fn change(&self, r: &Rules, acc: &mut Acc, pc: u8, cell: usize, sign: f32) {
        let a = self.acc;
        for v in 0..2 {
            let input = Self::input(r, v, pc, cell);
            let row = &self.l1w[input * a..][..a];
            for (x, w) in acc.v[v][..a].iter_mut().zip(row) { *x += sign * w; }
            acc.short[v] += sign * self.psqt[input];
        }
    }

    // The first layer from every piece on the board
    pub fn refresh(&self, r: &Rules, p: &Pos, acc: &mut Acc) {
        let a = self.acc;
        for v in 0..2 { acc.v[v][..a].copy_from_slice(&self.l1b); acc.short[v] = 0.0; }
        for i in 0..CELLS { if p.board[i] != 0 { self.change(r, acc, p.board[i], i, 1.0); } }
    }

    // The first layer after move m in position p, from p's: only what the move changes (the piece
    // leaves its cell; it, or what it promotes to, arrives; a piece taken goes, en passant too)
    pub fn update(&self, r: &Rules, p: &Pos, m: &Move, from: &Acc, to: &mut Acc) {
        let a = self.acc;
        for v in 0..2 { to.v[v][..a].copy_from_slice(&from.v[v][..a]); }
        to.short = from.short;
        let (f, t) = (m.from as usize, m.to as usize);
        let piece = p.board[f];
        let placed = if m.promo != 0 { m.promo | (p.turn << 3) } else { piece };
        self.change(r, to, piece, f, -1.0);
        self.change(r, to, placed, t, 1.0);
        if m.en_passant {
            let gone = r.g.pawn_back[p.turn as usize][t] as usize;
            self.change(r, to, p.board[gone], gone, -1.0);
        } else if p.board[t] != 0 {
            self.change(r, to, p.board[t], t, -1.0);
        }
    }

    // Layers 2 to 4 and the shortcut, from the first layer: the judgement for the side to move
    pub fn output(&self, acc: &Acc, turn: u8) -> f32 {
        let a = self.acc;
        let me = turn as usize;
        let shortcut = (acc.short[me] - acc.short[1 - me]) / 2.0;
        let (mine, other) = (&acc.v[me][..a], &acc.v[1 - me][..a]);
        let mut x = [0f32; 2 * MAX_ACC];
        for (k, v) in mine.iter().chain(other.iter()).enumerate() { x[k] = v.clamp(0.0, 1.0); }
        let x = &x[..2 * a];
        let layer = |w: &[f32], b: &[f32], x: &[f32], out: &mut [f32; H]| {
            for j in 0..H { out[j] = (b[j] + dot(&w[j * x.len()..][..x.len()], x)).clamp(0.0, 1.0); }
        };
        let (mut h1, mut h2) = ([0f32; H], [0f32; H]);
        layer(&self.l2w, &self.l2b, x, &mut h1);
        layer(&self.l3w, &self.l3b, &h1, &mut h2);
        self.l4b + dot(&self.l4w, &h2) + shortcut
    }
}

// A dot product as 8 sums side by side, which the compiler turns into vector instructions (one sum
// in order can't be: changing the order changes the rounding, so it isn't allowed to). The order
// differs from PyTorch's too; nn-check shows by how little.
#[inline]
fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut s = [0f32; 8];
    let (ca, cb) = (a.chunks_exact(8), b.chunks_exact(8));
    let (ra, rb) = (ca.remainder(), cb.remainder());
    for (x, y) in ca.zip(cb) { for k in 0..8 { s[k] += x[k] * y[k]; } }
    let mut total = s.iter().sum::<f32>();
    for (x, y) in ra.iter().zip(rb) { total += x * y; }
    total
}
