// Standard chess, through the rules interface every variant provides (see index.js). chess.js does
// the work. The same file runs in the browser and on the server, so both agree on every move.
//
// A position ("state") is a string the variant chooses: here, a FEN. A move is a string too: here,
// UCI ("e2e4", "e7e8q" for a promotion), the format engines and the server use.
import { Chess } from '../../vendor/chess.js';

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const toMove = uci => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

export default {
  id: 'chess',
  name: 'Chess',

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
