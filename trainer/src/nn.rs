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

    // How good the position is for the side to move, in pawns
    pub fn evaluate(&self, r: &Rules, p: &Pos) -> f32 {
        let a = self.acc;
        // Fixed-size room on the stack, nothing made on the heap for each position (MAX_ACC at most)
        let mut store = [[0f32; MAX_ACC]; 2];
        store[0][..a].copy_from_slice(&self.l1b);
        store[1][..a].copy_from_slice(&self.l1b);
        let [w0, w1] = &mut store;
        let mut views = [&mut w0[..a], &mut w1[..a]];            // White's point of view, Black's
        let mut short = [0f32; 2];                                // the shortcut, for each
        for i in 0..CELLS {
            let pc = p.board[i];
            if pc == 0 { continue; }
            let k = (kind(pc) - 1) as usize;
            let c = side(pc);
            for (v, view) in views.iter_mut().enumerate() {
                let theirs = (c as usize != v) as usize;
                let cell = if v == 0 { i } else { r.g.mirror[i] as usize };
                let input = theirs * KINDS * CELLS + k * CELLS + cell;
                let row = &self.l1w[input * a..][..a];
                for (x, w) in view.iter_mut().zip(row) { *x += w; }
                short[v] += self.psqt[input];
            }
        }
        let me = p.turn as usize;
        let shortcut = (short[me] - short[1 - me]) / 2.0;
        let (mine, other) = if p.turn == 0 { (&views[0], &views[1]) } else { (&views[1], &views[0]) };
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
