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
import chess from './chess.js';
import hex from './hex.js';

export const VARIANTS = { [chess.id]: chess, [hex.id]: hex };
export const DEFAULT_VARIANT = chess.id;

// The variant for an id, or null. Saved games from before variants existed have none: they're chess.
export const variant = id => VARIANTS[id ?? DEFAULT_VARIANT] || null;
