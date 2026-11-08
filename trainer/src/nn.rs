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

pub struct Net { acc: usize, l1w: Vec<f32>, l1b: Vec<f32>, l2w: Vec<f32>, l2b: Vec<f32>, l3w: Vec<f32>, l3b: Vec<f32>, l4w: Vec<f32>, l4b: f32, psqt: Vec<f32> }

impl Net {
    pub fn numbers(acc: usize) -> usize { INPUTS * acc + acc + H * 2 * acc + H + H * H + H + H + 1 + INPUTS }

    pub fn from_numbers(acc: usize, x: &[f32]) -> Option<Net> {
        if x.len() != Self::numbers(acc) { return None; }
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
        let mut views = [self.l1b.clone(), self.l1b.clone()];   // White's point of view, Black's
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
        let x: Vec<f32> = mine.iter().chain(other.iter()).map(|v| v.clamp(0.0, 1.0)).collect();
        let layer = |w: &[f32], b: &[f32], x: &[f32]| -> Vec<f32> {
            b.iter().enumerate().map(|(j, bj)| (bj + w[j * x.len()..][..x.len()].iter().zip(x).map(|(a, b)| a * b).sum::<f32>()).clamp(0.0, 1.0)).collect()
        };
        let h1 = layer(&self.l2w, &self.l2b, &x);
        let h2 = layer(&self.l3w, &self.l3b, &h1);
        self.l4b + self.l4w.iter().zip(&h2).map(|(a, b)| a * b).sum::<f32>() + shortcut
    }
}
