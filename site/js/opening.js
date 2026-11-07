// The strength meter for a secret opening (the password you play on the board when you sign up).
// It only warns, never blocks: how easy would this be to guess? Someone guessing would try short
// sequences and well-known openings first, so it looks at the length and at how far the moves follow
// the opening books (data/book.json, built from Lichess's openings list by tools/build-book.mjs).
import { variant } from './variants/index.js';

// A position's identity as 8 hex digits (FNV-1a, 32 bit), so the book is a small file. With the
// book's 7,982 positions, a position wrongly looking "known" has odds of about 1 in 540,000.
export function positionHash(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// book.json as sets and maps, for quick lookups
export function loadBook(json) {
  return { positions: new Set(json.positions), names: new Map(Object.entries(json.names)) };
}

// How guessable an opening is: { level, message, plies, inBook, name }. level is 'none' (no moves
// yet), 'weak', 'fair', 'good' or 'strong'. inBook counts the moves, from the first, that stay in the
// books; name is the best-known opening they follow, if any.
export function openingStrength(moves, book, variantId = 'chess') {
  const rules = variant(variantId);
  const plies = moves.length;
  if (!plies) return { level: 'none', message: 'Play your opening on the board.', plies, inBook: 0, name: null };
  const { states } = rules.replay(rules.start(), moves);
  let inBook = 0, name = null;
  for (let i = 1; i < states.length; i++) {
    const h = positionHash(rules.key(states[i]));
    if (!book.positions.has(h)) break;
    inBook = i;
    if (book.names.has(h)) name = book.names.get(h);
  }
  const moveWord = n => `${n} move${n === 1 ? '' : 's'}`;
  const known = name ? ` (${name})` : '';
  let level, message;
  if (plies <= 2) {
    level = 'weak';
    message = `Only ${moveWord(plies)}: easy to guess.`;
  } else if (inBook === plies) {
    level = plies < 8 ? 'weak' : 'fair';
    message = `Every move is straight from the opening books${known}, so it would be among the first things someone tried${plies < 8 ? '' : ', though its length helps'}.`;
  } else {
    const off = plies - inBook;
    level = plies >= 6 && off >= 2 ? 'strong' : plies >= 4 ? 'good' : 'fair';
    message = inBook
      ? `Leaves the opening books after ${moveWord(inBook)}${known}${level === 'strong' ? ': hard to guess.' : '. Longer is harder to guess.'}`
      : `Off the opening books from the first move${level === 'strong' ? ': hard to guess.' : '. Longer is harder to guess.'}`;
  }
  return { level, message, plies, inBook, name };
}
