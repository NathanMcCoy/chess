// The server's data: one SQLite file (chess.db) in the data folder, through Node's own node:sqlite.
// On the server the folder is /data in the container (the pool2/apps/chess dataset); the tests use a
// throwaway folder. The schema has a version number (SQLite's user_version): each step in STEPS
// runs once, in order, so later stages add tables without touching what's there.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const STEPS = [
  // 1: accounts, sessions, and each account's current game
  `CREATE TABLE accounts (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- shown as typed, matched ignoring case
     secret_variant TEXT NOT NULL,                -- which game the secret opening is played in
     secret_salt BLOB NOT NULL,
     secret_hash BLOB NOT NULL,                   -- scrypt of the opening; the opening itself is never kept
     created INTEGER NOT NULL,                    -- milliseconds since 1970, as JavaScript counts
     fails INTEGER NOT NULL DEFAULT 0,            -- wrong openings in a row
     locked_until INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,                 -- SHA-256 of the cookie's token; the token itself is never kept
     account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     created INTEGER NOT NULL,
     expires INTEGER NOT NULL
   );
   CREATE INDEX sessions_account ON sessions(account_id);
   CREATE TABLE current_games (
     account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
     data TEXT NOT NULL,                          -- the game as the browser saves it (JSON)
     updated INTEGER NOT NULL
   );`,
];

export function openDb(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'chess.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < STEPS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(STEPS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}
