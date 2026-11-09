"""Trains a small neural network to judge hex positions, for the site's bot (an NNUE-style network,
as modern Stockfish uses, sized for a browser). Runs on the GPU with PyTorch.

    D:/TRUENAS/CLAUDE/nn-venv/Scripts/python.exe nn/train.py D:/TRUENAS/CLAUDE/nn-data/gen5-5k.bin --out nn/hex-nn.json

The positions come from `trainer gen-data` (trainer/src/datagen.rs: 100 bytes each). The network,
which trainer/src/nn.rs computes the same way (tests/nn.test.mjs checks they agree):
  inputs, for each side's point of view: each piece as (mine or theirs, its kind, its cell counted
    from that side's end of the board: Black's cells mirrored as everywhere in the bot), 2 x 6 x 91
    = 1092 inputs that are 1 or 0
  layer 1: the same weights for both points of view, to --acc numbers each (128); the side to move's first,
    then the other's; each held between 0 and 1
  layers 2 and 3: --hidden numbers each (32), held between 0 and 1; then one number, the score in pawns for the
    side to move (the scale the search already uses)
Trained so that sigmoid(K * output) matches sigmoid(K * search score) (and --lambda parts the game's
result), K being how scores turn into chances of winning.
"""
import argparse, json, math, time
import numpy as np
import torch

CELLS, KINDS = 91, 6
INPUTS = 2 * KINDS * CELLS
RECORD = np.dtype([('board', 'u1', CELLS), ('turn', 'u1'), ('score', '<f4'), ('result', '<f4')])


def geometry():
    """The cells in hex.rs's order (file a to l, each from its bottom cell up), and each cell's
    mirror (the same file, the rank counted from the other end)."""
    cells = []
    for q in range(-5, 6):
        top, bottom = max(-5, -q - 5), min(5, -q + 5)
        for r in range(bottom, top - 1, -1):
            cells.append((q, r))
    index = {c: i for i, c in enumerate(cells)}
    mirror = [index[(q, -q - r)] for q, r in cells]   # same file: r -> top + bottom - r = -q - r
    return np.array(mirror, dtype=np.int64)


MIRROR = geometry()


def features(board, turn, device):
    """The two points of view as rows of 1s and 0s: (side to move's, the other side's)."""
    b = torch.as_tensor(board, device=device).long()
    n = b.shape[0]
    kind = b & 7
    colour = b >> 3
    on = kind > 0
    cell = torch.arange(CELLS, device=device).expand(n, CELLS)
    mirror = torch.as_tensor(MIRROR, device=device).expand(n, CELLS)
    views = []
    for side in (0, 1):   # White's point of view, then Black's
        theirs = (colour != side).long()
        c = cell if side == 0 else mirror
        idx = theirs * (KINDS * CELLS) + (kind - 1).clamp(min=0) * CELLS + c
        # Empty cells go to a spare column, dropped after: they once went to column 0, a real input (a
        # pawn of mine on a1), and could overwrite its 1 with their 0
        x = torch.zeros(n, INPUTS + 1, device=device)
        x.scatter_(1, torch.where(on, idx, torch.full_like(idx, INPUTS)), on.float())
        views.append(x[:, :INPUTS])
    t = torch.as_tensor(turn, device=device).bool().unsqueeze(1)
    mine = torch.where(t, views[1], views[0])
    other = torch.where(t, views[0], views[1])
    return mine, other


class Net(torch.nn.Module):
    """The layers, plus a shortcut straight to the output: a value for each input (a piece of a kind
    on a cell, mine or theirs), added up for each point of view, the side to move's less the
    other's, halved (as Stockfish's NNUE has its "PSQT" part). It starts as the bot's trained tables
    (--start), so material always counts, and the layers learn only what the tables miss: without
    it, the first network valued a queen at 6.25 pawns and played no better than the untrained bot."""
    def __init__(self, start=None, acc=128, hidden=32):
        super().__init__()
        self.l1 = torch.nn.Linear(INPUTS, acc)
        self.l2 = torch.nn.Linear(2 * acc, hidden)
        self.l3 = torch.nn.Linear(hidden, hidden)
        self.l4 = torch.nn.Linear(hidden, 1)
        self.psqt = torch.nn.Linear(INPUTS, 1, bias=False)
        with torch.no_grad():
            self.psqt.weight.copy_(torch.as_tensor(start if start is not None else np.zeros(INPUTS), dtype=torch.float32).unsqueeze(0))

    def forward(self, mine, other):
        x = torch.cat([self.l1(mine).clamp(0, 1), self.l1(other).clamp(0, 1)], dim=1)
        x = self.l2(x).clamp(0, 1)
        x = self.l3(x).clamp(0, 1)
        return self.l4(x).squeeze(1) + (self.psqt(mine) - self.psqt(other)).squeeze(1) / 2


def tables(path):
    """The shortcut's starting values from a weights file (site/data/bot/hex.json): for an input seen
    from either side, a piece of mine on (my view's) cell c is worth its value plus its value on c;
    one of theirs, the negative of that on the mirror of c (their own view of the cell)."""
    w = json.load(open(path))
    v = np.array(w['values'])
    out = np.zeros(INPUTS)
    for theirs in (0, 1):
        for k in range(KINDS):
            for c in range(CELLS):
                own = MIRROR[c] if theirs else c
                x = v[k] + v[KINDS + k * CELLS + own]
                out[theirs * KINDS * CELLS + k * CELLS + c] = -x if theirs else x
    return out


def load_into(net, path, acc, hidden):
    """A network this script wrote (JSON) into `net`, which must be the same size. The file has layer 1
    as [input][acc] (a piece adds its row, for the Rust): PyTorch keeps it as [acc][input]."""
    w = json.load(open(path))
    if w['acc'] != acc or w.get('hidden', 32) != hidden:
        raise SystemExit(f"--init {path} is {w['acc']}/{w.get('hidden', 32)}, not {acc}/{hidden}")
    t = lambda x, shape: torch.as_tensor(np.array(x, dtype=np.float32).reshape(shape))
    state = {
        'l1.weight': t(w['l1']['w'], (INPUTS, acc)).T.contiguous(), 'l1.bias': t(w['l1']['b'], (acc,)),
        'l2.weight': t(w['l2']['w'], (hidden, 2 * acc)), 'l2.bias': t(w['l2']['b'], (hidden,)),
        'l3.weight': t(w['l3']['w'], (hidden, hidden)), 'l3.bias': t(w['l3']['b'], (hidden,)),
        'l4.weight': t(w['l4']['w'], (1, hidden)), 'l4.bias': t(w['l4']['b'], (1,)),
        'psqt.weight': t(w['psqt'], (1, INPUTS)),
    }
    net.load_state_dict({k: v.to(next(net.parameters()).device) for k, v in state.items()})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('data', nargs='+')
    ap.add_argument('--out', default='nn/hex-nn.json')
    ap.add_argument('--epochs', type=int, default=20)
    ap.add_argument('--batch', type=int, default=16384)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--lambda', dest='lam', type=float, default=0.0)
    ap.add_argument('--k', type=float, default=0.6, help='how a score in pawns turns into a chance of winning')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--acc', type=int, default=128, help="layer 1's numbers for each point of view")
    ap.add_argument('--hidden', type=int, default=32, help='layers 2 and 3: how many numbers each')
    ap.add_argument('--start', default='site/data/bot/hex.json', help='weights to start the shortcut from ("none": nothing)')
    ap.add_argument('--init', help='a network (JSON, this script\'s) of the same size to start from, instead of afresh: '
                    'a warm start, so a few passes do (nn/loop.mjs --warm)')
    ap.add_argument('--patience', type=int, default=0,
                    help='stop when the kept-back error has not improved for this many passes, keeping the best pass (0: never)')
    a = ap.parse_args()
    torch.manual_seed(a.seed)
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    data = np.concatenate([np.fromfile(f, dtype=RECORD) for f in a.data])
    rng = np.random.default_rng(a.seed)
    # The last 5% kept back, to see whether it learns or memorises: taken before shuffling, because
    # each game's positions are together in the file, so these are (nearly all) whole other games.
    # (Kept back at random, positions from the same games were on both sides, and that flattered it.)
    hold = max(1, len(data) // 20)
    test, train = data[-hold:], data[:-hold].copy()
    rng.shuffle(train)
    print(f'{len(train)} positions to learn from, {len(test)} kept back, on {dev}')

    def target(d):
        s = torch.as_tensor(d['score'], device=dev)
        r = torch.as_tensor(d['result'], device=dev)
        return a.lam * r + (1 - a.lam) * torch.sigmoid(a.k * s)

    net = Net(None if a.start == 'none' else tables(a.start), a.acc, a.hidden).to(dev)
    if a.init:
        load_into(net, a.init, a.acc, a.hidden)
        print(f'starting from {a.init}')
    opt = torch.optim.Adam(net.parameters(), lr=a.lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=a.epochs)

    def loss_on(d):
        mine, other = features(d['board'], d['turn'], dev)
        return torch.mean((torch.sigmoid(a.k * net(mine, other)) - target(d)) ** 2)

    best_held, best_state, since = float('inf'), None, 0
    for epoch in range(a.epochs):
        t = time.time()
        net.train()
        order = rng.permutation(len(train))
        total = 0.0
        for i in range(0, len(train), a.batch):
            d = train[order[i:i + a.batch]]
            loss = loss_on(d)
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += loss.item() * len(d)
        sched.step()
        net.eval()
        with torch.no_grad():
            held = sum(loss_on(test[i:i + a.batch]).item() * len(test[i:i + a.batch]) for i in range(0, len(test), a.batch)) / len(test)
        print(f'  epoch {epoch + 1}: error {total / len(train):.5f}, on the kept-back positions {held:.5f}, {time.time() - t:.1f} s')
        if a.patience:
            if held < best_held:
                best_held, since = held, 0
                best_state = {k: v.detach().clone() for k, v in net.state_dict().items()}
            else:
                since += 1
                if since >= a.patience:
                    print(f'  stopped: no better on the kept-back positions for {since} passes')
                    break
    if best_state is not None:
        net.load_state_dict(best_state)   # the best pass, not the last
        print(f'  kept the best pass: on the kept-back positions {best_held:.5f}')

    # The weights, for trainer/src/nn.rs (row-major: each output's weights in a row)
    w = {name: p.detach().cpu().numpy() for name, p in net.state_dict().items()}
    out = {
        'about': 'The bot\'s neural network for hex: see nn/train.py. Layer weights are [outputs][inputs].',
        'inputs': INPUTS, 'acc': a.acc, 'hidden': a.hidden, 'k': a.k, 'lambda': a.lam, 'positions': len(train),
        'l1': {'w': w['l1.weight'].T.ravel().tolist(), 'b': w['l1.bias'].tolist()},   # l1 as [input][acc]: a piece adds its row
        'l2': {'w': w['l2.weight'].ravel().tolist(), 'b': w['l2.bias'].tolist()},
        'l3': {'w': w['l3.weight'].ravel().tolist(), 'b': w['l3.bias'].tolist()},
        'l4': {'w': w['l4.weight'].ravel().tolist(), 'b': w['l4.bias'].tolist()},
        'psqt': w['psqt.weight'].ravel().tolist(),   # one value for each input
    }
    # A few positions with what this network makes of them, so the Rust can be checked against it
    sample = test[:200]
    with torch.no_grad():
        mine, other = features(sample['board'], sample['turn'], dev)
        out['check'] = [{'board': s['board'].tolist(), 'turn': int(s['turn']), 'value': float(v)}
                        for s, v in zip(sample, net(mine, other).cpu().numpy())]
    with open(a.out, 'w') as f:
        json.dump(out, f)
    print(f'wrote {a.out}')


if __name__ == '__main__':
    main()
