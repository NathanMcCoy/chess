// Gliński's hexagonal chess, the same rules as site/js/variants/hex.js, written for speed. The cells
// are numbered in the same order as there (file a to l, each from its bottom cell up), so a weights
// file means the same here and in the browser. tests/trainer.test.mjs plays thousands of positions
// through both and checks every legal move, every position after one, and the end-of-game rules.
//
// A piece is a byte: 0 is an empty cell; the kind is the low 3 bits (1 P, 2 N, 3 B, 4 R, 5 Q, 6 K)
// and Black's pieces have bit 3 set.

pub const CELLS: usize = 91;
pub const FILES: &[u8; 11] = b"abcdefghikl";
const RADIUS: i32 = 5;

pub const PAWN: u8 = 1;
pub const KNIGHT: u8 = 2;
pub const BISHOP: u8 = 3;
pub const ROOK: u8 = 4;
pub const QUEEN: u8 = 5;
pub const KING: u8 = 6;
pub const BLACK: u8 = 8;
pub const LETTERS: &[u8; 7] = b".PNBRQK";

#[inline] pub fn kind(p: u8) -> u8 { p & 7 }
#[inline] pub fn side(p: u8) -> u8 { p >> 3 }   // 0 White, 1 Black

// --- The board's shape, worked out once -----------------------------------------------------------
pub struct Geometry {
    pub q: [i32; CELLS],
    pub r: [i32; CELLS],
    pub file: [u8; CELLS],      // 0..10
    pub rank: [u8; CELLS],      // 1..11
    pub file_len: [u8; 11],
    pub index: [[i16; 11]; 11], // [q+5][r+5] -> cell, or -1
    pub mirror: [u8; CELLS],
    pub info: [[f64; 2]; CELLS], // [how far up for White, how near the middle]
    // For each direction list: [direction][cell] -> the next cell, or -1
    pub edges: [[i16; CELLS]; 6],
    pub corners: [[i16; CELLS]; 6],
    pub knight: [[i16; CELLS]; 12],
    pub pawn_forward: [[i16; CELLS]; 2],
    pub pawn_back: [[i16; CELLS]; 2],
    pub pawn_captures: [[[i16; CELLS]; 2]; 2],
    pub pawn_from: [[[i16; CELLS]; 2]; 2],  // where a pawn attacking this cell would stand
    pub pawn_start: [[bool; CELLS]; 2],
    pub last: [[bool; CELLS]; 2],
    pub start: [u8; CELLS],
}

const EDGES: [(i32, i32); 6] = [(0, -1), (1, -1), (1, 0), (0, 1), (-1, 1), (-1, 0)];
const CORNERS: [(i32, i32); 6] = [(1, -2), (2, -1), (1, 1), (-1, 2), (-2, 1), (-1, -1)];
const KNIGHTS: [(i32, i32); 12] = [(1, -3), (2, -3), (3, -2), (3, -1), (2, 1), (1, 2), (-1, 3), (-2, 3), (-3, 2), (-3, 1), (-2, -1), (-1, -2)];
const FORWARD: [(i32, i32); 2] = [(0, -1), (0, 1)];
const CAPTURES: [[(i32, i32); 2]; 2] = [[(-1, 0), (1, -1)], [(1, 0), (-1, 1)]];

impl Geometry {
    pub fn new() -> Geometry {
        let mut g = Geometry {
            q: [0; CELLS], r: [0; CELLS], file: [0; CELLS], rank: [0; CELLS], file_len: [0; 11],
            index: [[-1; 11]; 11], mirror: [0; CELLS], info: [[0.0; 2]; CELLS],
            edges: [[-1; CELLS]; 6], corners: [[-1; CELLS]; 6], knight: [[-1; CELLS]; 12],
            pawn_forward: [[-1; CELLS]; 2], pawn_back: [[-1; CELLS]; 2],
            pawn_captures: [[[-1; CELLS]; 2]; 2], pawn_from: [[[-1; CELLS]; 2]; 2],
            pawn_start: [[false; CELLS]; 2], last: [[false; CELLS]; 2], start: [0; CELLS],
        };
        let mut n = 0;
        for q in -RADIUS..=RADIUS {
            let top = (-RADIUS).max(-q - RADIUS);
            let bottom = RADIUS.min(-q + RADIUS);
            let mut r = bottom;
            while r >= top {
                g.q[n] = q; g.r[n] = r;
                g.file[n] = (q + RADIUS) as u8;
                g.rank[n] = (bottom - r + 1) as u8;
                g.index[(q + 5) as usize][(r + 5) as usize] = n as i16;
                n += 1;
                r -= 1;
            }
        }
        assert_eq!(n, CELLS);
        for i in 0..CELLS { g.file_len[g.file[i] as usize] = g.file_len[g.file[i] as usize].max(g.rank[i]); }
        let at = |g: &Geometry, q: i32, r: i32| -> i16 {
            if (-5..=5).contains(&q) && (-5..=5).contains(&r) { g.index[(q + 5) as usize][(r + 5) as usize] } else { -1 }
        };
        for i in 0..CELLS {
            let (q, r) = (g.q[i], g.r[i]);
            for (k, d) in EDGES.iter().enumerate() { g.edges[k][i] = at(&g, q + d.0, r + d.1); }
            for (k, d) in CORNERS.iter().enumerate() { g.corners[k][i] = at(&g, q + d.0, r + d.1); }
            for (k, d) in KNIGHTS.iter().enumerate() { g.knight[k][i] = at(&g, q + d.0, r + d.1); }
            for s in 0..2 {
                g.pawn_forward[s][i] = at(&g, q + FORWARD[s].0, r + FORWARD[s].1);
                g.pawn_back[s][i] = at(&g, q - FORWARD[s].0, r - FORWARD[s].1);
                for c in 0..2 {
                    g.pawn_captures[s][c][i] = at(&g, q + CAPTURES[s][c].0, r + CAPTURES[s][c].1);
                    g.pawn_from[s][c][i] = at(&g, q - CAPTURES[s][c].0, r - CAPTURES[s][c].1);
                }
            }
        }
        // Black's side: the same file, the rank counted from the other end
        for i in 0..CELLS {
            let f = g.file[i];
            let rank = g.file_len[f as usize] - g.rank[i] + 1;
            g.mirror[i] = g.cell(f, rank).unwrap() as u8;
        }
        let height: Vec<f64> = (0..CELLS).map(|i| g.r[i] as f64 + g.q[i] as f64 / 2.0).collect();
        let low = height.iter().cloned().fold(f64::INFINITY, f64::min);
        let high = height.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        for i in 0..CELLS {
            let (q, r) = (g.q[i], g.r[i]);
            let dist = q.abs().max(r.abs()).max((q + r).abs()) as f64;
            g.info[i] = [(high - height[i]) / (high - low), 1.0 - dist / RADIUS as f64];
        }
        for f in 0..11u8 {
            g.last[0][g.cell(f, g.file_len[f as usize]).unwrap()] = true;
            g.last[1][g.cell(f, 1).unwrap()] = true;
        }
        // The start: White's pieces, and Black's mirrored
        let white: [(u8, &[&str]); 6] = [
            (KING, &["g1"]), (QUEEN, &["e1"]), (ROOK, &["c1", "i1"]), (KNIGHT, &["d1", "h1"]),
            (BISHOP, &["f1", "f2", "f3"]), (PAWN, &["b1", "c2", "d3", "e4", "f5", "g4", "h3", "i2", "k1"]),
        ];
        for (k, names) in white.iter() {
            for name in names.iter() {
                let i = g.named(name).unwrap();
                g.start[i] = *k;
                g.start[g.mirror[i] as usize] = *k | BLACK;
                if *k == PAWN { g.pawn_start[0][i] = true; g.pawn_start[1][g.mirror[i] as usize] = true; }
            }
        }
        g
    }
    pub fn cell(&self, file: u8, rank: u8) -> Option<usize> {
        (0..CELLS).find(|&i| self.file[i] == file && self.rank[i] == rank)
    }
    pub fn named(&self, name: &str) -> Option<usize> {
        let first = *name.as_bytes().first()?;
        let f = FILES.iter().position(|&c| c == first)? as u8;
        let rank: u8 = name[1..].parse().ok()?;
        self.cell(f, rank)
    }
    pub fn name(&self, i: usize) -> String {
        format!("{}{}", FILES[self.file[i] as usize] as char, self.rank[i])
    }
}

// --- Positions --------------------------------------------------------------------------------------
#[derive(Clone)]
pub struct Pos {
    pub board: [u8; CELLS],
    pub turn: u8,     // 0 White, 1 Black
    pub ep: i16,      // the cell a pawn just passed over, or -1
    pub half: u16,
    pub full: u16,
    pub hash: u64,    // the same exactly when the pieces, the side to move and `ep` are
    pub kings: [i16; 2],
    pub majors: u8,   // pawns, rooks and queens on the board (both sides): kept up as pieces go,
    pub minors: u8,   // and knights and bishops, so drawn() needn't count them every time
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Move {
    pub from: u8,
    pub to: u8,
    pub promo: u8,     // the kind promoted to, or 0
    pub captured: u8,  // the kind taken, or 0
    pub en_passant: bool,
    pub double: i16,   // the cell passed over by a pawn's two-step, or -1
}

// Fixed random numbers for the hash: one per piece on each cell, the side to move, each ep cell
pub struct Keys { pub piece: [[u64; CELLS]; 16], pub black: u64, pub ep: [u64; CELLS] }
impl Keys {
    pub fn new() -> Keys {
        let mut x: u64 = 0x9E3779B97F4A7C15;
        let mut next = || { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x };
        let mut k = Keys { piece: [[0; CELLS]; 16], black: 0, ep: [0; CELLS] };
        for p in 0..16 { for i in 0..CELLS { k.piece[p][i] = next(); } }
        k.black = next();
        for i in 0..CELLS { k.ep[i] = next(); }
        k
    }
}

pub struct Rules { pub g: Geometry, pub keys: Keys }

impl Rules {
    pub fn new() -> Rules { Rules { g: Geometry::new(), keys: Keys::new() } }

    pub fn start(&self) -> Pos { self.make(self.g.start, 0, -1, 0, 1) }

    fn make(&self, board: [u8; CELLS], turn: u8, ep: i16, half: u16, full: u16) -> Pos {
        let mut p = Pos { board, turn, ep, half, full, hash: 0, kings: [-1, -1], majors: 0, minors: 0 };
        p.hash = self.hash_of(&p);
        for i in 0..CELLS {
            match kind(board[i]) {
                0 => {}
                KING => p.kings[side(board[i]) as usize] = i as i16,
                KNIGHT | BISHOP => p.minors += 1,
                _ => p.majors += 1,
            }
        }
        p
    }
    fn hash_of(&self, p: &Pos) -> u64 {
        let mut h = 0;
        for i in 0..CELLS { if p.board[i] != 0 { h ^= self.keys.piece[p.board[i] as usize][i]; } }
        if p.turn == 1 { h ^= self.keys.black; }
        if p.ep >= 0 { h ^= self.keys.ep[p.ep as usize]; }
        h
    }

    // Is cell i attacked by side `by`?
    pub fn attacked(&self, board: &[u8; CELLS], i: usize, by: u8) -> bool {
        let g = &self.g;
        let mine = |j: i16, kinds: &[u8]| j >= 0 && { let p = board[j as usize]; p != 0 && side(p) == by && kinds.contains(&kind(p)) };
        for d in 0..6 {
            let n = g.edges[d][i];
            if mine(n, &[KING]) { return true; }
            let mut j = n;
            while j >= 0 { let p = board[j as usize]; if p != 0 { if side(p) == by && (kind(p) == ROOK || kind(p) == QUEEN) { return true; } break; } j = g.edges[d][j as usize]; }
        }
        for d in 0..6 {
            let n = g.corners[d][i];
            if mine(n, &[KING]) { return true; }
            let mut j = n;
            while j >= 0 { let p = board[j as usize]; if p != 0 { if side(p) == by && (kind(p) == BISHOP || kind(p) == QUEEN) { return true; } break; } j = g.corners[d][j as usize]; }
        }
        for d in 0..12 { if mine(g.knight[d][i], &[KNIGHT]) { return true; } }
        for c in 0..2 { if mine(g.pawn_from[by as usize][c][i], &[PAWN]) { return true; } }
        false
    }

    pub fn in_check(&self, p: &Pos) -> bool {
        let k = p.kings[p.turn as usize];
        k >= 0 && self.attacked(&p.board, k as usize, p.turn ^ 1)
    }

    // Every move that follows the pieces' rules (the king may still be left in check), in the same
    // order as hex.js makes them
    pub fn pseudo(&self, p: &Pos, out: &mut Vec<Move>) {
        out.clear();
        let g = &self.g;
        let turn = p.turn;
        let b = &p.board;
        let add = |out: &mut Vec<Move>, from: usize, to: usize, promo: u8, ep: bool, double: i16| {
            let captured = if ep { PAWN } else { kind(b[to]) };
            out.push(Move { from: from as u8, to: to as u8, promo, captured, en_passant: ep, double });
        };
        for i in 0..CELLS {
            let pc = b[i];
            if pc == 0 || side(pc) != turn { continue; }
            let k = kind(pc);
            let slide = |out: &mut Vec<Move>, table: &[[i16; CELLS]]| {
                for dir in table {
                    let mut j = dir[i];
                    while j >= 0 {
                        let t = b[j as usize];
                        if t == 0 { add(out, i, j as usize, 0, false, -1); j = dir[j as usize]; continue; }
                        if side(t) != turn { add(out, i, j as usize, 0, false, -1); }
                        break;
                    }
                }
            };
            let leap = |out: &mut Vec<Move>, table: &[[i16; CELLS]]| {
                for dir in table {
                    let j = dir[i];
                    if j >= 0 { let t = b[j as usize]; if t == 0 || side(t) != turn { add(out, i, j as usize, 0, false, -1); } }
                }
            };
            match k {
                ROOK => slide(out, &g.edges),
                BISHOP => slide(out, &g.corners),
                QUEEN => { slide(out, &g.edges); slide(out, &g.corners); }
                KING => { leap(out, &g.edges); leap(out, &g.corners); }
                KNIGHT => leap(out, &g.knight),
                _ => {
                    let s = turn as usize;
                    let pawn_to = |out: &mut Vec<Move>, j: usize| {
                        if g.last[s][j] { for promo in [QUEEN, ROOK, BISHOP, KNIGHT] { add(out, i, j, promo, false, -1); } }
                        else { add(out, i, j, 0, false, -1); }
                    };
                    let one = g.pawn_forward[s][i];
                    if one >= 0 && b[one as usize] == 0 {
                        pawn_to(out, one as usize);
                        let two = g.pawn_forward[s][one as usize];
                        if g.pawn_start[s][i] && two >= 0 && b[two as usize] == 0 { add(out, i, two as usize, 0, false, one); }
                    }
                    for c in 0..2 {
                        let j = g.pawn_captures[s][c][i];
                        if j < 0 { continue; }
                        let t = b[j as usize];
                        if t != 0 && side(t) != turn { pawn_to(out, j as usize); }
                        else if j == p.ep { add(out, i, j as usize, 0, true, -1); }
                    }
                }
            }
        }
    }

    // The position after a move (assumed to follow the pieces' rules)
    pub fn play(&self, p: &Pos, m: &Move) -> Pos {
        let k = &self.keys;
        let mut n = p.clone();
        let (from, to) = (m.from as usize, m.to as usize);
        let piece = n.board[from];
        let placed = if m.promo != 0 { m.promo | (p.turn << 3) } else { piece };
        let mut h = p.hash ^ k.piece[piece as usize][from];
        if n.board[to] != 0 { h ^= k.piece[n.board[to] as usize][to]; }
        h ^= k.piece[placed as usize][to];
        n.board[to] = placed;
        n.board[from] = 0;
        if m.en_passant {
            let gone = self.g.pawn_back[p.turn as usize][to] as usize;
            h ^= k.piece[n.board[gone] as usize][gone];
            n.board[gone] = 0;
        }
        if kind(piece) == KING { n.kings[p.turn as usize] = to as i16; }
        match m.captured {
            0 => {}
            KING => n.kings[(p.turn ^ 1) as usize] = -1,
            KNIGHT | BISHOP => n.minors -= 1,
            _ => n.majors -= 1,
        }
        if m.promo != 0 {   // a pawn (major) becomes the piece promoted to
            n.majors -= 1;
            if m.promo == KNIGHT || m.promo == BISHOP { n.minors += 1 } else { n.majors += 1 }
        }
        if p.ep >= 0 { h ^= k.ep[p.ep as usize]; }
        n.ep = m.double;
        if n.ep >= 0 { h ^= k.ep[n.ep as usize]; }
        n.turn = p.turn ^ 1;
        h ^= k.black;
        n.half = if kind(piece) == PAWN || m.captured != 0 { 0 } else { p.half + 1 };
        if p.turn == 1 { n.full += 1; }
        n.hash = h;
        n
    }

    // Does the move leave the mover's king safe? (Only the board is changed for this: no hash.)
    #[inline]
    pub fn safe(&self, p: &Pos, m: &Move) -> bool {
        let king = p.kings[p.turn as usize];
        let k = if king == m.from as i16 { m.to as i16 } else { king };
        if k < 0 { return true; }
        let mut b = p.board;
        b[m.to as usize] = if m.promo != 0 { m.promo | (p.turn << 3) } else { b[m.from as usize] };
        b[m.from as usize] = 0;
        if m.en_passant { b[self.g.pawn_back[p.turn as usize][m.to as usize] as usize] = 0; }
        !self.attacked(&b, k as usize, p.turn ^ 1)
    }

    // What's needed to tell which moves are legal without testing each: is the king in check, and
    // which of the mover's pieces are pinned (stand between their king and an enemy rook, bishop or
    // queen on its line). A move needs the full test only if it's the king's, en passant, made in
    // check, or by a pinned piece; any other move can't leave the king attacked.
    fn pins(&self, p: &Pos) -> (bool, u128) {
        let king = p.kings[p.turn as usize];
        if king < 0 { return (false, 0); }
        let k = king as usize;
        let check = self.attacked(&p.board, k, p.turn ^ 1);
        let mut pinned: u128 = 0;
        for (table, a, b) in [(&self.g.edges, ROOK, QUEEN), (&self.g.corners, BISHOP, QUEEN)] {
            for dir in table.iter() {
                let mut j = dir[k];
                let mut own = -1i16;
                while j >= 0 {
                    let pc = p.board[j as usize];
                    if pc != 0 {
                        if side(pc) == p.turn {
                            if own >= 0 { break; }   // two of ours: no pin on this line
                            own = j;
                        } else {
                            if own >= 0 && (kind(pc) == a || kind(pc) == b) { pinned |= 1u128 << own; }
                            break;
                        }
                    }
                    j = dir[j as usize];
                }
            }
        }
        (check, pinned)
    }
    #[inline]
    fn needs_test(&self, p: &Pos, m: &Move, check: bool, pinned: u128) -> bool {
        check || m.en_passant || m.from as i16 == p.kings[p.turn as usize] || pinned & (1u128 << m.from) != 0
    }

    pub fn legal(&self, p: &Pos, out: &mut Vec<Move>, scratch: &mut Vec<Move>) {
        self.pseudo(p, scratch);
        out.clear();
        let (check, pinned) = self.pins(p);
        for m in scratch.iter() { if !self.needs_test(p, m, check, pinned) || self.safe(p, m) { out.push(*m); } }
    }

    // The legal captures and promotions only (what following captures to the end needs), and whether
    // there's any legal move at all, from one pass over the moves
    pub fn legal_captures(&self, p: &Pos, out: &mut Vec<Move>, scratch: &mut Vec<Move>) -> bool {
        self.pseudo(p, scratch);
        out.clear();
        let (check, pinned) = self.pins(p);
        let ok = |m: &Move| !self.needs_test(p, m, check, pinned) || self.safe(p, m);
        let mut any = false;
        for m in scratch.iter() {
            if m.captured != 0 || m.promo != 0 {
                if ok(m) { out.push(*m); any = true; }
            } else if !any && ok(m) { any = true; }
        }
        any
    }

    // A draw whatever happens next: too few pieces to mate, or the fifty-move rule
    // (as hex.js: no pieces but the kings, or one knight or bishop besides them)
    pub fn drawn(&self, p: &Pos) -> bool {
        p.half >= 100 || (p.majors == 0 && p.minors <= 1)
    }

    pub fn move_text(&self, m: &Move) -> String {
        let promo = if m.promo != 0 { (LETTERS[m.promo as usize] as char).to_ascii_lowercase().to_string() } else { String::new() };
        format!("{}{}{}", self.g.name(m.from as usize), self.g.name(m.to as usize), promo)
    }

    // --- To and from the text form hex.js uses ---------------------------------------------------
    pub fn format(&self, p: &Pos) -> String {
        let g = &self.g;
        let mut files = Vec::new();
        for f in 0..11u8 {
            let mut out = String::new();
            let mut empty = 0;
            for rank in 1..=g.file_len[f as usize] {
                let pc = p.board[g.cell(f, rank).unwrap()];
                if pc == 0 { empty += 1; continue; }
                if empty > 0 { out += &empty.to_string(); empty = 0; }
                let c = LETTERS[kind(pc) as usize] as char;
                out.push(if side(pc) == 0 { c } else { c.to_ascii_lowercase() });
            }
            if empty > 0 { out += &empty.to_string(); }
            files.push(out);
        }
        let ep = if p.ep < 0 { "-".to_string() } else { g.name(p.ep as usize) };
        format!("{} {} {} {} {}", files.join("/"), if p.turn == 0 { 'w' } else { 'b' }, ep, p.half, p.full)
    }

    pub fn parse(&self, text: &str) -> Option<Pos> {
        let g = &self.g;
        let parts: Vec<&str> = text.split_whitespace().collect();
        if parts.len() != 5 { return None; }
        let files: Vec<&str> = parts[0].split('/').collect();
        if files.len() != 11 { return None; }
        let mut board = [0u8; CELLS];
        for (f, s) in files.iter().enumerate() {
            let mut rank: u32 = 1;
            let mut digits = String::new();
            let flush = |digits: &mut String, rank: &mut u32| { if !digits.is_empty() { *rank += digits.parse::<u32>().unwrap(); digits.clear(); } };
            for ch in s.chars() {
                if ch.is_ascii_digit() { digits.push(ch); continue; }
                flush(&mut digits, &mut rank);
                let k = LETTERS.iter().position(|&c| c as char == ch.to_ascii_uppercase())? as u8;
                if k == 0 { return None; }
                let i = g.cell(f as u8, rank as u8)?;
                board[i] = k | if ch.is_ascii_lowercase() { BLACK } else { 0 };
                rank += 1;
            }
            flush(&mut digits, &mut rank);
            if rank != g.file_len[f] as u32 + 1 { return None; }
        }
        let turn = match parts[1] { "w" => 0, "b" => 1, _ => return None };
        let ep = if parts[2] == "-" { -1 } else { g.named(parts[2])? as i16 };
        Some(self.make(board, turn, ep, parts[3].parse().ok()?, parts[4].parse().ok()?))
    }
}
