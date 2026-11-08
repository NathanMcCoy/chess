// Standard chess, through the rules interface every variant provides (see index.js). chess.js does
// the work. The same file runs in the browser and on the server, so both agree on every move.
//
// A position ("state") is a string the variant chooses: here, a FEN. A move is a string too: here,
// UCI ("e2e4", "e7e8q" for a promotion), the format engines and the server use.
import { Chess } from '../../vendor/chess.js';

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const toMove = uci => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

// --- For bots: fast play (see index.js). A position is its FEN; one chess.js board is loaded with
// each in turn. Cell i is file + 8 * (rank - 1): a1 is 0, h8 is 63.
const board = new Chess();
let loaded = null;   // the FEN on `board` now: a search asks several things of each position in a row
const use = fen => { if (fen !== loaded) { board.load(fen, { skipValidation: true }); loaded = fen; } return board; };
const engine = {
  // Nothing judged beyond where the pieces stand, for now: square chess has Stockfish
  extraNames: [],
  extras: () => [],
  // How much material is left (knights and bishops 1, rooks 2, queens 4; 24 at the start)
  phase: fen => {
    let n = 0;
    for (const ch of fen.split(' ')[0]) n += { n: 1, b: 1, r: 2, q: 4 }[ch.toLowerCase()] || 0;
    return Math.min(1, n / 24);
  },
  cells: 64,
  mirror: i => (i % 8) + 8 * (7 - Math.floor(i / 8)),
  // How far up the board for White (rank 1 is 0, rank 8 is 1), and how near the middle (1 in it)
  cellInfo: i => [Math.floor(i / 8) / 7, 1 - (Math.max(Math.abs((i % 8) - 3.5), Math.abs(Math.floor(i / 8) - 3.5)) - 0.5) / 3],
  from: state => { try { return new Chess(state).fen(); } catch { return null; } },
  state: fen => fen,
  moves: fen => use(fen).moves({ verbose: true }),
  play: (fen, m) => { const b = use(fen); b.move({ from: m.from, to: m.to, promotion: m.promotion }); return (loaded = b.fen()); },
  text: m => m.from + m.to + (m.promotion || ''),
  turn: fen => fen.split(' ')[1],
  key: fen => fen.split(' ').slice(0, 4).join(' '),
  inCheck: fen => use(fen).inCheck(),
  captured: (fen, m) => (m.captured ? m.captured.toUpperCase() : null),
  promotion: m => (m.promotion ? m.promotion.toUpperCase() : null),
  pieces: fen => {
    const out = [];
    fen.split(' ')[0].split('/').forEach((row, k) => {
      let file = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) { file += Number(ch); continue; }
        out.push([ch.toUpperCase(), file + 8 * (7 - k), ch === ch.toUpperCase() ? 'w' : 'b']);
        file++;
      }
    });
    return out;
  },
  drawn: fen => Number(fen.split(' ')[4]) >= 100 || use(fen).isInsufficientMaterial(),
  noMoves: fen => (use(fen).inCheck() ? { winner: fen.split(' ')[1] === 'w' ? 'b' : 'w', reason: 'checkmate' } : { winner: null, reason: 'stalemate' }),
};

export default {
  id: 'chess',
  name: 'Chess',
  engine,

  start: () => new Chess().fen(),

  turn: state => state.split(' ')[1],   // 'w' or 'b'

  // What makes two positions the same, for the opening book and for repetition: the pieces, the
  // side to move, castling rights and en passant (a FEN without its move counters)
  key: state => state.split(' ').slice(0, 4).join(' '),

  legal: state => new Chess(state).moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || '')),

  // Plays `moves` from `start`, checking each one. Gives every position on the way (states[0] is
  // the start), each move as people write it (names, "Nf3"), and the result if the game ended
  // ({ winner: 'w' | 'b' | null, reason }), or { error, at } for the first move that isn't legal.
  replay(start, moves) {
    let game;
    try { game = new Chess(start); } catch { return { error: 'not a position', at: -1 }; }
    const states = [game.fen()], names = [];
    for (let i = 0; i < moves.length; i++) {
      if (typeof moves[i] !== 'string' || !UCI.test(moves[i])) return { error: 'not a move', at: i };
      if (result(game)) return { error: 'the game was already over', at: i };
      let m;
      try { m = game.move(toMove(moves[i])); } catch { return { error: 'not a legal move', at: i }; }
      states.push(game.fen());
      names.push(m.san);
    }
    return { states, names, result: result(game) };
  },
};

function result(game) {
  if (game.isCheckmate()) return { winner: game.turn() === 'w' ? 'b' : 'w', reason: 'checkmate' };
  if (game.isStalemate()) return { winner: null, reason: 'stalemate' };
  if (game.isInsufficientMaterial()) return { winner: null, reason: 'material' };
  if (game.isThreefoldRepetition()) return { winner: null, reason: 'repetition' };
  if (game.isDrawByFiftyMoves()) return { winner: null, reason: 'fifty' };
  return null;
}
