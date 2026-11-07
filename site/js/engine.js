// Stockfish in a background worker, so the page never freezes while it thinks. It speaks UCI, the
// standard text protocol for chess engines: we send lines like "go depth 6", it answers with lines
// like "bestmove e2e4".
const ENGINE = 'vendor/stockfish/stockfish-19-lite-single.js';
// Some failures make no sound at all (a missing .wasm file: the worker just never answers), so every
// wait has a time limit. Generous ones: a slow phone on a slow connection takes a while to fetch
// and start the 1.8 MB engine, and the strongest level thinks for 2 s.
const START_LIMIT_MS = 30000;
const ANSWER_SPARE_MS = 30000;   // on top of the level's own thinking time

export class Engine {
  constructor() {
    this.failure = null;   // why it stopped working, once it has
    this.failed = new Promise((_, reject) => { this.reject = reject; });
    this.failed.catch(() => {});   // only ever read through race() below
    this.worker = new Worker(ENGINE);
    this.waiting = new Set();
    this.worker.onmessage = e => { for (const w of [...this.waiting]) w(String(e.data)); };
    this.worker.onerror = e => {
      e.preventDefault();
      this.fail(e.message ? `it crashed (${e.message})` : 'its files couldn’t be loaded');
    };
    this.ready = this.within(START_LIMIT_MS, `it didn’t start within ${START_LIMIT_MS / 1000} seconds`,
      this.ask('uci', line => line === 'uciok').then(() => this.ask('isready', line => line === 'readyok')));
  }

  // Marks the engine as broken (the first reason sticks) and stops the worker
  fail(reason) {
    if (this.failure) return;
    this.failure = reason;
    this.reject(new Error(reason));
    this.worker.terminate();
  }

  // Waits for `promise`, but fails the engine with `reason` if that takes longer than `ms`
  within(ms, reason, promise) {
    const timer = setTimeout(() => this.fail(reason), ms);
    return Promise.race([promise, this.failed]).finally(() => clearTimeout(timer));
  }

  // Sends a command and resolves with the first line that `done` accepts
  ask(command, done) {
    return new Promise(resolve => {
      const listen = line => { if (done(line)) { this.waiting.delete(listen); resolve(line); } };
      this.waiting.add(listen);
      this.worker.postMessage(command);
    });
  }

  // The engine's move for a position, at a level's settings. Resolves with a move in UCI form
  // ("e7e8q" = e7 to e8, promoting to a queen), or null if there is none.
  async bestMove(fen, { skill, depth, movetime }) {
    await this.ready;
    this.worker.postMessage(`setoption name Skill Level value ${skill}`);
    this.worker.postMessage(`position fen ${fen}`);
    const limits = [depth && `depth ${depth}`, movetime && `movetime ${movetime}`].filter(Boolean).join(' ');
    const line = await this.within((movetime || 1000) + ANSWER_SPARE_MS, 'it stopped answering',
      this.ask(`go ${limits}`, l => l.startsWith('bestmove')));
    const move = line.split(/\s+/)[1];
    return move && move !== '(none)' ? move : null;
  }

  // Full-strength analysis of one position, for the game review: the best move and the evaluation
  // from the point of view of the side to move: { cp } in hundredths of a pawn, or { mate } in moves
  // (negative = being mated). Reads the "info" lines the engine streams as it searches deeper, and
  // keeps the last complete one (not "upperbound"/"lowerbound" guesses) before its "bestmove".
  async analyse(fen, { depth = 16, movetime = 500 } = {}) {
    await this.ready;
    this.worker.postMessage('setoption name Skill Level value 20');
    this.worker.postMessage(`position fen ${fen}`);
    let score = null;
    const line = await this.within(movetime + ANSWER_SPARE_MS, 'it stopped answering',
      this.ask(`go depth ${depth} movetime ${movetime}`, l => {
        if (l.startsWith('info ') && !/ (upper|lower)bound/.test(l)) {
          const m = l.match(/ score (cp|mate) (-?\d+)/);
          if (m) score = { [m[1]]: Number(m[2]) };
        }
        return l.startsWith('bestmove');
      }));
    const best = line.split(/\s+/)[1];
    return { best: best && best !== '(none)' ? best : null, score };
  }

  // The best few lines from a position (Stockfish's MultiPV), for the review's "top lines". Calls
  // `update(lines, depth)` each time a search depth is complete, so the lines can be shown as they
  // improve, and resolves with the final ones. Each line: { score, pv: ['e2e4', 'e7e5', ...] }, the
  // score from the side to move's point of view. Searches run one after another: a new one waits
  // for the last to finish (stop() makes that quick), so the end of an old search is never taken
  // for the end of a new one.
  lines(fen, { count = 3, depth = 18, movetime = 1500 } = {}, update = () => {}) {
    const run = async () => {
      await this.ready;
      this.worker.postMessage('setoption name Skill Level value 20');
      this.worker.postMessage(`setoption name MultiPV value ${count}`);
      this.worker.postMessage(`position fen ${fen}`);
      const found = [];
      let shownDepth = 0;
      await this.within(movetime + ANSWER_SPARE_MS, 'it stopped answering',
        this.ask(`go depth ${depth} movetime ${movetime}`, l => {
          const m = l.startsWith('info ') && !/ (upper|lower)bound/.test(l)
            && l.match(/ depth (\d+) .*?multipv (\d+) .*?score (cp|mate) (-?\d+) .*? pv (.+)$/);
          if (m) {
            const [, d, k, kind, value, pv] = m;
            found[Number(k) - 1] = { depth: Number(d), score: { [kind]: Number(value) }, pv: pv.trim().split(/\s+/) };
            // A depth is complete when every line has reached it (or there are fewer legal moves)
            const at = Number(d);
            if (Number(k) === found.length && found.every(f => f && f.depth === at) && at > shownDepth) {
              shownDepth = at;
              update(found.slice(), at);
            }
          }
          return l.startsWith('bestmove');
        }));
      return found.filter(Boolean);
    };
    this.queue = (this.queue || Promise.resolve()).catch(() => {}).then(run);
    return this.queue;
  }

  // Tells it to stop thinking: it answers its current "go" straight away (that answer is ignored)
  stop() { if (!this.failure) this.worker.postMessage('stop'); }

  newGame() { if (!this.failure) this.worker.postMessage('ucinewgame'); }
}

// Ten strengths. Stockfish's own Skill Level (0 to 20) weakens its choices; the depth and time
// limits stop it seeing far ahead. Level 1 also plays a random legal move half the time, because
// even Skill Level 0 is too strong for someone who has just learned the moves.
export const LEVELS = [
  { name: 'Just learning', skill: 0, depth: 1, movetime: 50, random: 0.5 },
  { name: 'Beginner', skill: 0, depth: 1, movetime: 50 },
  { name: 'Novice', skill: 3, depth: 2, movetime: 100 },
  { name: 'Casual', skill: 6, depth: 3, movetime: 150 },
  { name: 'Club player', skill: 9, depth: 4, movetime: 200 },
  { name: 'Strong club', skill: 12, depth: 6, movetime: 300 },
  { name: 'Expert', skill: 15, depth: 8, movetime: 400 },
  { name: 'Master', skill: 18, depth: 10, movetime: 600 },
  { name: 'Grandmaster', skill: 20, depth: 14, movetime: 1000 },
  { name: 'Full strength', skill: 20, movetime: 2000 },
];
