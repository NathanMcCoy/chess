// Stockfish in a background worker, so the page never freezes while it thinks. It speaks UCI, the
// standard text protocol for chess engines: we send lines like "go depth 6", it answers with lines
// like "bestmove e2e4".
const ENGINE = 'vendor/stockfish/stockfish-19-lite-single.js';

export class Engine {
  constructor() {
    this.worker = new Worker(ENGINE);
    this.waiting = new Set();
    this.worker.onmessage = e => { for (const w of [...this.waiting]) w(String(e.data)); };
    this.worker.onerror = e => { this.failed = e.message || 'the engine could not start'; };
    this.ready = this.ask('uci', line => line === 'uciok').then(() => this.ask('isready', line => line === 'readyok'));
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
    const line = await this.ask(`go ${limits}`, l => l.startsWith('bestmove'));
    const move = line.split(/\s+/)[1];
    return move && move !== '(none)' ? move : null;
  }

  // Tells it to stop thinking: it answers its current "go" straight away (that answer is ignored)
  stop() { this.worker.postMessage('stop'); }

  newGame() { this.worker.postMessage('ucinewgame'); }
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
