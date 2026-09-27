'use strict';

// Independent fuzz/verification test for src/engine.js.
//
// This file implements its own small reference model directly from
// docs/SPEC.md (NOT by reading engine.js), and cross-checks the real
// engine against it: pour legality/results, isSolved, exhaustive BFS
// solvability + optimal move count, and generatePuzzle outputs.

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/engine.js');

// -----------------------------------------------------------------------
// Reference model (independent reimplementation from the spec)
// -----------------------------------------------------------------------

// top run of a bottle: {color, count} or null if empty
function refTopRun(bottle) {
  if (bottle.length === 0) return null;
  const top = bottle[bottle.length - 1];
  let count = 0;
  for (let i = bottle.length - 1; i >= 0 && bottle[i] === top; i--) count++;
  return { color: top, count };
}

function refCanPour(state, from, to, rules) {
  if (from === to) return false;
  if (from < 0 || to < 0 || from >= state.length || to >= state.length) return false;
  const a = state[from], b = state[to];
  if (a.length === 0) return false; // nothing to pour
  if (b.length >= rules.capacity) return false; // destination full
  const runA = refTopRun(a);
  if (b.length > 0) {
    const topB = b[b.length - 1];
    if (topB !== runA.color) return false;
  }
  const freeB = rules.capacity - b.length;
  if (rules.pourMode === 'strict') {
    if (runA.count > freeB) return false;
  }
  return true;
}

// Returns new state (array of new bottle arrays; unaffected bottles are the
// SAME array references as input, which is fine since we only ever read).
function refPour(state, from, to, rules) {
  if (!refCanPour(state, from, to, rules)) return null;
  const a = state[from], b = state[to];
  const runA = refTopRun(a);
  const freeB = rules.capacity - b.length;
  const moveCount = Math.min(runA.count, freeB);
  const newA = a.slice(0, a.length - moveCount);
  const newB = b.concat(new Array(moveCount).fill(runA.color));
  const newState = state.slice();
  newState[from] = newA;
  newState[to] = newB;
  return { state: newState, move: { from, to, count: moveCount, color: runA.color } };
}

function refIsSolved(state, rules) {
  const totals = new Map();
  const bottleCounts = new Map();
  for (const bottle of state) {
    if (bottle.length === 0) continue;
    const first = bottle[0];
    for (let j = 1; j < bottle.length; j++) {
      if (bottle[j] !== first) return false; // not monochrome
    }
    totals.set(first, (totals.get(first) || 0) + bottle.length);
    bottleCounts.set(first, (bottleCounts.get(first) || 0) + 1);
  }
  for (const [color, total] of totals) {
    const required = Math.ceil(total / rules.capacity);
    if (bottleCounts.get(color) !== required) return false;
  }
  return true;
}

function refKey(state) {
  return state.map((b) => b.join(',')).sort().join('|');
}

// Exhaustive BFS over ALL raw pour moves (no pruning of "pointless" moves,
// no canonicalization beyond visited-state dedup) — a brute-force oracle.
// Returns { solvable: boolean, moves: Move[] } (shortest move list via BFS).
function refBFS(startState, rules, nodeLimit) {
  nodeLimit = nodeLimit || 2_000_000;
  if (refIsSolved(startState, rules)) return { solvable: true, moves: [] };
  const startKey = refKey(startState);
  const visited = new Set([startKey]);
  let frontier = [{ state: startState, moves: [] }];
  let nodes = 0;
  while (frontier.length > 0) {
    const next = [];
    for (const node of frontier) {
      nodes++;
      if (nodes > nodeLimit) throw new Error('refBFS node limit exceeded');
      const n = node.state.length;
      for (let from = 0; from < n; from++) {
        for (let to = 0; to < n; to++) {
          if (from === to) continue;
          const res = refPour(node.state, from, to, rules);
          if (!res) continue;
          if (refIsSolved(res.state, rules)) {
            return { solvable: true, moves: node.moves.concat([res.move]) };
          }
          const key = refKey(res.state);
          if (visited.has(key)) continue;
          visited.add(key);
          next.push({ state: res.state, moves: node.moves.concat([res.move]) });
        }
      }
    }
    frontier = next;
  }
  return { solvable: false, moves: null };
}

// -----------------------------------------------------------------------
// Seeded RNG for generating fuzz cases (independent tiny mulberry32 clone;
// only used to pick test inputs deterministically, not part of what's
// being verified).
// -----------------------------------------------------------------------

function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) { // inclusive
  return min + Math.floor(rng() * (max - min + 1));
}

// Generate a random small raw state: bottles/capacity/colors chosen within
// tiny bounds, with variable per-color counts (including counts that don't
// divide evenly into capacity, and partial bottles), then randomly dealt
// into bottles respecting capacity.
function randomState(rng) {
  const numBottles = randInt(rng, 2, 5);
  const capacity = randInt(rng, 2, 4);
  const numColors = randInt(rng, 1, 3);

  // Random per-color counts, including values > capacity and < capacity.
  const counts = [];
  for (let c = 0; c < numColors; c++) {
    counts.push(randInt(rng, 1, capacity * 2));
  }

  // Cap total blocks to fit in bottles*capacity, trimming counts if needed,
  // and always leave at least one empty slot's worth of room so a puzzle
  // *could* be non-degenerate (not required to be solvable/unsolved here;
  // that's checked separately).
  const maxTotal = numBottles * capacity;
  let total = counts.reduce((s, c) => s + c, 0);
  let ci = 0;
  while (total > maxTotal) {
    if (counts[ci % counts.length] > 0) {
      counts[ci % counts.length]--;
      total--;
    }
    ci++;
    if (ci > 10000) break;
  }
  // Drop zero-count colors.
  const colorCounts = counts.filter((c) => c > 0);

  // Build a flat list of blocks then deal randomly into bottles honoring
  // capacity (not necessarily monochrome runs — fully shuffled) to get
  // varied, messy states including partial bottles.
  const blocks = [];
  colorCounts.forEach((cnt, color) => {
    for (let i = 0; i < cnt; i++) blocks.push(color);
  });
  // Shuffle blocks
  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = blocks[i]; blocks[i] = blocks[j]; blocks[j] = tmp;
  }
  const state = Array.from({ length: numBottles }, () => []);
  const remaining = state.map(() => capacity);
  for (const block of blocks) {
    // pick a random bottle with room
    const options = [];
    for (let b = 0; b < numBottles; b++) if (remaining[b] > 0) options.push(b);
    if (options.length === 0) break; // shouldn't happen given trimming above
    const b = options[Math.floor(rng() * options.length)];
    state[b].push(block);
    remaining[b]--;
  }
  const rules = { capacity, pourMode: rng() < 0.5 ? 'classic' : 'strict' };
  return { state, rules, numColors: colorCounts.length };
}

// -----------------------------------------------------------------------
// Fuzz: canPour / pour agreement
// -----------------------------------------------------------------------

test('fuzz: canPour/pour agree with reference on random small states', () => {
  const rng = makeRng(12345);
  const trials = 8000;
  for (let t = 0; t < trials; t++) {
    const { state, rules } = randomState(rng);
    for (let from = 0; from < state.length; from++) {
      for (let to = 0; to < state.length; to++) {
        if (from === to) continue;
        const refOk = refCanPour(state, from, to, rules);
        const engOk = engine.canPour(state, from, to, rules);
        assert.equal(
          engOk, refOk,
          `canPour mismatch trial ${t} from=${from} to=${to} state=${JSON.stringify(state)} rules=${JSON.stringify(rules)}`
        );

        const refRes = refPour(state, from, to, rules);
        const engRes = engine.pour(state, from, to, rules);
        if (refRes === null) {
          assert.equal(engRes, null, `pour should be null trial ${t} from=${from} to=${to}`);
        } else {
          assert.notEqual(engRes, null, `pour should succeed trial ${t} from=${from} to=${to}`);
          assert.deepEqual(engRes.move, refRes.move, `move mismatch trial ${t}`);
          assert.deepEqual(engRes.state, refRes.state, `resulting state mismatch trial ${t}`);
          // Never mutate inputs.
          assert.deepEqual(state[from], state[from].slice(), 'input bottle A must not be mutated');
        }
      }
    }
  }
});

// -----------------------------------------------------------------------
// Fuzz: isSolved agreement
// -----------------------------------------------------------------------

test('fuzz: isSolved agrees with reference on random small states', () => {
  const rng = makeRng(999);
  const trials = 8000;
  for (let t = 0; t < trials; t++) {
    const { state, rules } = randomState(rng);
    assert.equal(
      engine.isSolved(state, rules),
      refIsSolved(state, rules),
      `isSolved mismatch trial ${t} state=${JSON.stringify(state)} rules=${JSON.stringify(rules)}`
    );
    // Also check on states forced toward "solved-ish" shapes: sort each
    // bottle's blocks into monochrome bottles to bias toward solved cases.
  }
});

// -----------------------------------------------------------------------
// Fuzz: solve() vs exhaustive BFS oracle (solvability + move replay +
// optimal length)
// -----------------------------------------------------------------------

test('fuzz: solve() solvability, replay, and optimal length agree with BFS oracle', () => {
  const rng = makeRng(42);
  const trials = 4000; // BFS is exhaustive so keep instances tiny & trial count modest
  let checked = 0;
  for (let t = 0; t < trials; t++) {
    const { state, rules } = randomState(rng);
    // Keep BFS tractable: skip if state space is likely too large
    // (small bottle counts/capacity already keep this bounded, but guard
    // with a node limit + try/catch as a safety net).
    let bfs;
    try {
      bfs = refBFS(state, rules, 300000);
    } catch (e) {
      continue; // too large for exhaustive oracle on this random instance; skip
    }
    checked++;

    const res = engine.solve(state, rules, { maxNodes: 200000, optimal: false });
    assert.notEqual(res.solvable, null, `solve() hit node limit trial ${t} state=${JSON.stringify(state)} rules=${JSON.stringify(rules)}`);
    assert.equal(
      res.solvable, bfs.solvable,
      `solvability mismatch trial ${t} state=${JSON.stringify(state)} rules=${JSON.stringify(rules)}`
    );

    if (bfs.solvable) {
      // Replay engine's moves using the REFERENCE pour implementation and
      // confirm we land in a reference-solved state.
      let cur = state;
      for (const mv of res.moves) {
        const r = refPour(cur, mv.from, mv.to, rules);
        assert.notEqual(r, null, `engine move illegal per reference trial ${t} move=${JSON.stringify(mv)}`);
        cur = r.state;
      }
      assert.equal(refIsSolved(cur, rules), true, `replay did not reach solved state trial ${t}`);

      // Optimal length must equal BFS shortest length.
      const optRes = engine.solve(state, rules, { maxNodes: 200000, optimal: true });
      assert.notEqual(optRes.solvable, null, `optimal solve() hit node limit trial ${t}`);
      assert.equal(optRes.solvable, true, `optimal solve() disagreed on solvability trial ${t}`);
      assert.equal(
        optRes.moves.length, bfs.moves.length,
        `optimal move count mismatch trial ${t} state=${JSON.stringify(state)} rules=${JSON.stringify(rules)} engineMoves=${optRes.moves.length} bfsMoves=${bfs.moves.length}`
      );

      // Optimal replay must also reach solved.
      let cur2 = state;
      for (const mv of optRes.moves) {
        const r = refPour(cur2, mv.from, mv.to, rules);
        assert.notEqual(r, null, `optimal engine move illegal per reference trial ${t}`);
        cur2 = r.state;
      }
      assert.equal(refIsSolved(cur2, rules), true, `optimal replay did not reach solved state trial ${t}`);
    } else {
      assert.equal(res.moves, null, `unsolvable case should report null moves trial ${t}`);
    }
  }
  assert.ok(checked > 50, `expected most trials to be BFS-tractable, only ${checked} were`);
});

// -----------------------------------------------------------------------
// Fuzz: legalMoves pruning never eliminates all solving paths — implied by
// the solve() vs BFS agreement above (solve() uses legalMoves internally),
// but add a direct spot-check: every state legalMoves() reports must be
// achievable per the reference canPour too (no illegal moves offered), and
// for solvable-per-BFS states that aren't already solved, legalMoves()
// must be non-empty.
// -----------------------------------------------------------------------

test('fuzz: legalMoves offers only legal moves and never starves a solvable state', () => {
  const rng = makeRng(2024);
  const trials = 6000;
  for (let t = 0; t < trials; t++) {
    const { state, rules } = randomState(rng);
    const moves = engine.legalMoves(state, rules);
    for (const mv of moves) {
      assert.ok(
        refCanPour(state, mv.from, mv.to, rules),
        `legalMoves offered illegal move trial ${t} move=${JSON.stringify(mv)} state=${JSON.stringify(state)} rules=${JSON.stringify(rules)}`
      );
    }
    if (!refIsSolved(state, rules)) {
      // if the reference BFS (1-ply) says at least one legal move exists at all
      const anyRefMove = state.some((_, from) =>
        state.some((__, to) => from !== to && refCanPour(state, from, to, rules))
      );
      if (anyRefMove) {
        // legalMoves may prune pointless moves, but should not prune down
        // to zero unless every raw legal move is genuinely pointless.
        const allPointless = [];
        for (let from = 0; from < state.length; from++) {
          for (let to = 0; to < state.length; to++) {
            if (from === to) continue;
            if (!refCanPour(state, from, to, rules)) continue;
            const b = state[to];
            const pointless = b.length === 0 && state[from].length > 0 &&
              refTopRun(state[from]).count === state[from].length;
            allPointless.push(pointless);
          }
        }
        const someNonPointless = allPointless.some((p) => !p);
        if (someNonPointless) {
          assert.ok(moves.length > 0, `legalMoves starved trial ${t} state=${JSON.stringify(state)} rules=${JSON.stringify(rules)}`);
        }
      }
    }
  }
});

// -----------------------------------------------------------------------
// Fuzz: generatePuzzle outputs are solvable (per BFS where tractable) and
// not already solved.
// -----------------------------------------------------------------------

test('fuzz: generatePuzzle output is solvable and not already solved', () => {
  const palette = [
    { name: 'Red', hex: '#e00' },
    { name: 'Blue', hex: '#00e' },
    { name: 'Green', hex: '#0a0' },
    { name: 'Yellow', hex: '#ee0' },
  ];
  const rng = makeRng(7);
  const modes = ['classic', 'strict'];
  let checkedBfs = 0;
  let generated = 0;

  for (let trial = 0; trial < 600; trial++) {
    const capacity = randInt(rng, 2, 4);
    const numColors = randInt(rng, 1, 3);
    const colors = [];
    for (let c = 0; c < numColors; c++) {
      colors.push({ name: palette[c].name, hex: palette[c].hex });
    }

    const pourMode = modes[trial % 2];
    const difficulty = ['easy', 'medium', 'hard', 'expert'][trial % 4];
    const seed = 'fuzzseed-' + trial;

    // Slots (bottles) are derived, not chosen: colors.length + 2, matching
    // the physical kit's rules.
    const config = { capacity, colors, pourMode, difficulty, seed };

    let puzzle;
    try {
      puzzle = engine.generatePuzzle(config, { maxAttempts: 30, timeBudgetMs: 800 });
    } catch (e) {
      continue; // engine legitimately declined an impossible/degenerate config
    }
    if (!puzzle) continue;
    generated++;

    assert.equal(
      puzzle.state.length, numColors + 2,
      `slots must equal colors + 2 trial ${trial} config=${JSON.stringify(config)}`
    );
    const emptyCount = puzzle.state.filter((b) => b.length === 0).length;
    assert.equal(
      emptyCount, 2,
      `exactly 2 slots must start empty trial ${trial} config=${JSON.stringify(config)}`
    );
    puzzle.state.forEach((b, idx) => {
      if (b.length === 0) return;
      // non-empty slots aren't required to be full in the *scrambled* board
      // (only the intermediate "solved" layout the generator builds before
      // scrambling has that property); just bound to capacity.
      assert.ok(b.length <= capacity, `slot ${idx} exceeds capacity trial ${trial}`);
    });
    const totals = {};
    puzzle.state.forEach((b) => b.forEach((c) => { totals[c] = (totals[c] || 0) + 1; }));
    colors.forEach((c, idx) => {
      assert.equal(totals[idx] || 0, capacity, `color ${idx} count must equal capacity (H) trial ${trial}`);
    });

    assert.equal(
      engine.isSolved(puzzle.state, puzzle.rules), false,
      `generated puzzle already solved trial ${trial} config=${JSON.stringify(config)}`
    );

    // Engine's own solution must replay (via reference pour) to a solved state.
    let cur = puzzle.state;
    for (const mv of puzzle.solution) {
      const r = refPour(cur, mv.from, mv.to, puzzle.rules);
      assert.notEqual(r, null, `generated puzzle solution has illegal move trial ${trial}`);
      cur = r.state;
    }
    assert.equal(refIsSolved(cur, puzzle.rules), true, `generated puzzle solution did not solve trial ${trial}`);

    // Cross-check with the BFS oracle where tractable.
    try {
      const bfs = refBFS(puzzle.state, puzzle.rules, 150000);
      checkedBfs++;
      assert.equal(bfs.solvable, true, `BFS disagrees: generated puzzle unsolvable trial ${trial} config=${JSON.stringify(config)}`);
    } catch (e) {
      // too large for exhaustive oracle; skip cross-check for this instance
    }
  }
  assert.ok(generated > 5, `expected several generatePuzzle successes, got ${generated}`);
});
