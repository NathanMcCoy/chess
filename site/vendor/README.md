# Libraries (copied as-is, not edited)

| File | From | Version | License |
|---|---|---|---|
| `chess.js` | npm `chess.js`, `dist/esm/chess.js` | 1.4.0 | BSD-2-Clause |
| `chessground.js` | npm `chessground`, `dist/chessground.min.js` | 9.2.1 | GPL-3.0-or-later |
| `chessground.base.css`, `chessground.cburnett.css` | npm `chessground`, `assets/` (cburnett pieces by Colin M.L. Burnett) | 9.2.1 | GPL-3.0-or-later |
| `stockfish/stockfish-19-lite-single.js` + `.wasm` | npm `stockfish` (Stockfish.js by Nathan Rugg), `bin/` | 19.0.1 | GPL-3.0 |

Full license texts are in `licenses/`. Stockfish's source: https://github.com/official-stockfish/Stockfish
and https://github.com/nmrugg/stockfish.js. To update one, download it with `npm pack <name>` (which runs
nothing), copy the same files over, and change the version here, in a commit of its own.
