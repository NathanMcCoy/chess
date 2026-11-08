// The variants the site plays. Everything shared (accounts, games, challenge links, the live games
// list, saved games) goes through this interface and stores the variant's id with each game, so a
// new variant is a new module here, not a change everywhere else. Gliński's hexagonal chess comes
// (hex.js) has its rules here; its board comes next. Nothing shared may assume 8 files, 64 squares
// or square colours. A result may carry points ({ w, b }) when a draw isn't split evenly.
//
// A variant module provides:
//   id, name             'chess', 'Chess'
//   start()              the starting position, as a string the variant chooses
//   turn(state)          'w' or 'b'
//   key(state)           what makes two positions the same (for repetition and the opening book)
//   legal(state)         the legal moves, as strings in the variant's notation
//   replay(start, moves) { states, names, result } or { error, at }: plays and checks a whole game
//
// And for bots (site/js/bot/), `engine`: fast play on the variant's own position and move objects,
// which only the variant understands. A bot uses nothing else, so one bot plays every variant.
//   cells, mirror(i)     how many cells; cell i as Black sees it (for "this piece is well placed")
//   cellInfo(i)          [how far up the board for White, 0 to 1; how near the middle, 0 to 1]
//   phase(pos)           how much material is left: 1 at the start, 0 with only kings and pawns
//   extraNames, extras(pos)   what else the bot judges (names, and the numbers: White's less Black's)
//   from(state), state(pos)   a position object from a state string (null if not valid), and back
//   moves(pos)           the legal moves;  play(pos, move): the position after one
//   text(move)           the move as legal() writes it;  turn(pos), inCheck(pos) as above
//   key(pos)             a string that's the same exactly when key() is (it may be written differently)
//   captured(pos, move)  the type taken ('P', 'N', 'B', 'R', 'Q') or null;  promotion(move): likewise
//   pieces(pos)          [[type, cell, 'w' | 'b'], ...]
//   drawn(pos)           a draw whatever follows (too few pieces, the fifty-move rule)
//   noMoves(pos)         the result when the side to move has none: checkmate or stalemate
import chess from './chess.js';
import hex from './hex.js';

export const VARIANTS = { [chess.id]: chess, [hex.id]: hex };
export const DEFAULT_VARIANT = chess.id;

// The variant for an id, or null. Saved games from before variants existed have none: they're chess.
export const variant = id => VARIANTS[id ?? DEFAULT_VARIANT] || null;
