'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const CP = require('../src/engine.js');

function makeColors(n) {
  const colors = [];
  for (let i = 0; i < n; i++) colors.push({ name: 'c' + i, hex: '#' + (i * 111111 % 999999) });
  return colors;
}

// Config shape now matches the physical kit: the user only picks the number
// of distinct colors (colors.length) and the slot height (capacity). Slots
// (bottles) are always colors.length + 2, exactly 2 of them start empty, and
// every other slot starts completely full (capacity blocks of one color).
const CONFIGS = [
  { name: '3 colors/H3', capacity: 3, colors: makeColors(3) },
  { name: '8 colors/H4', capacity: 4, colors: makeColors(8) },
  { name: '4 colors/H5', capacity: 5, colors: makeColors(4) },
  { name: '12 colors/H4', capacity: 4, colors: makeColors(12) },
];

const DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'];
const POUR_MODES = ['classic', 'strict'];
const SEEDS = [1, 2, 3];

test('generatePuzzle: valid, solvable, correct shape, for many seeds/configs/difficulties/modes', () => {
  for (const cfg of CONFIGS) {
    for (const pourMode of POUR_MODES) {
      for (const difficulty of DIFFICULTIES) {
        for (const seed of SEEDS) {
          const config = {
            capacity: cfg.capacity,
            colors: cfg.colors,
            pourMode,
            difficulty,
            seed,
          };
          const puzzle = CP.generatePuzzle(config, { timeBudgetMs: 4000 });
          assert.ok(puzzle, cfg.name + ' ' + pourMode + ' ' + difficulty + ' seed=' + seed);

          const validation = CP.validateState(puzzle.state, puzzle.rules);
          assert.equal(validation.ok, true, JSON.stringify(validation.errors));

          assert.equal(CP.isSolved(puzzle.state, puzzle.rules), false, 'must not already be solved');

          // slots = colors + 2, always
          assert.equal(puzzle.state.length, cfg.colors.length + 2,
            'slots must equal colors + 2, got ' + puzzle.state.length);

          // exactly 2 slots start empty; every other slot starts completely
          // full (capacity blocks), matching the physical kit's rules
          const emptySlots = puzzle.state.filter((b) => b.length === 0).length;
          assert.equal(emptySlots, 2, 'exactly 2 slots must start empty, got ' + emptySlots);
          puzzle.state.forEach((b, idx) => {
            if (b.length === 0) return;
            assert.equal(b.length, cfg.capacity, 'slot ' + idx + ' must start completely full (height H) or empty');
          });

          // each color count === capacity (H), i.e. every color appears
          // exactly H times total
          const counts = {};
          puzzle.state.forEach((b) => b.forEach((c) => { counts[c] = (counts[c] || 0) + 1; }));
          cfg.colors.forEach((c, idx) => {
            assert.equal(counts[idx] || 0, cfg.capacity, 'color ' + idx + ' count must equal capacity (H)');
          });
          puzzle.colors.forEach((c) => {
            assert.equal(c.count, cfg.capacity, 'returned color count must equal capacity (H)');
          });

          // solution replays to solved
          assert.ok(Array.isArray(puzzle.solution) && puzzle.solution.length > 0);
          const states = CP.applyMoves(puzzle.state, puzzle.solution, puzzle.rules);
          assert.equal(CP.isSolved(states[states.length - 1], puzzle.rules), true);
        }
      }
    }
  }
});

test('generatePuzzle: setup invariant (slots = colors+2, exactly 2 empty, others full at H) holds across many N/H/seed combos', () => {
  for (const numColors of [2, 3, 5, 8]) {
    for (const capacity of [2, 3, 4, 6]) {
      const colors = makeColors(numColors);
      for (let seed = 1; seed <= 3; seed++) {
        const puzzle = CP.generatePuzzle({ capacity, colors, seed }, { timeBudgetMs: 3000 });
        assert.equal(puzzle.state.length, numColors + 2,
          `N=${numColors} H=${capacity} seed=${seed}: slots must be colors+2`);
        const emptySlots = puzzle.state.filter((b) => b.length === 0).length;
        assert.equal(emptySlots, 2,
          `N=${numColors} H=${capacity} seed=${seed}: exactly 2 slots must start empty`);
        puzzle.state.forEach((b, idx) => {
          if (b.length === 0) return;
          assert.equal(b.length, capacity,
            `N=${numColors} H=${capacity} seed=${seed}: slot ${idx} must be completely full or empty`);
        });
        const totals = {};
        puzzle.state.forEach((b) => b.forEach((c) => { totals[c] = (totals[c] || 0) + 1; }));
        colors.forEach((c, idx) => {
          assert.equal(totals[idx] || 0, capacity,
            `N=${numColors} H=${capacity} seed=${seed}: color ${idx} must appear exactly H times`);
        });
        assert.equal(CP.isSolved(puzzle.state, puzzle.rules), false,
          `N=${numColors} H=${capacity} seed=${seed}: must not start already solved`);
      }
    }
  }
});

test('generatePuzzle: same seed produces an identical puzzle (determinism)', () => {
  const config = { capacity: 4, colors: makeColors(8), difficulty: 'hard', seed: 'repeat-me' };
  const p1 = CP.generatePuzzle(config);
  const p2 = CP.generatePuzzle(config);
  assert.deepEqual(p1.state, p2.state);
  assert.deepEqual(p1.solution, p2.solution);
});

test('generatePuzzle: throws clear Errors for impossible/invalid configs', () => {
  assert.throws(() => CP.generatePuzzle({
    capacity: 1, colors: [{ name: 'a', hex: '#f00' }],
  }), /capacity.*>= 2/);

  assert.throws(() => CP.generatePuzzle({
    capacity: 4, colors: [],
  }), /at least 2 distinct colors/);

  assert.throws(() => CP.generatePuzzle({
    capacity: 4, colors: [{ name: 'a', hex: '#f00' }],
  }), /at least 2 distinct colors/);

  assert.throws(() => CP.generatePuzzle({
    capacity: 4, colors: [{ name: '', hex: '#f00' }, { name: 'b', hex: '#0f0' }],
  }), /non-empty name/);

  assert.throws(() => CP.generatePuzzle({
    capacity: 0, colors: [{ name: 'a', hex: '#f00' }],
  }), /capacity/);
});

test('generatePuzzle: ignores legacy/removed knobs (bottles, emptyBottles, per-color count)', () => {
  // These fields conflicted with the physical game's fixed rules (slots
  // derived as colors+2, always exactly 2 empty, colors always full at H)
  // and are no longer configurable. Passing them must not change the
  // derived shape.
  const colors = makeColors(5).map((c) => Object.assign({ count: 999 }, c));
  const config = {
    capacity: 4,
    colors,
    bottles: 40,       // ignored: slots are always colors.length + 2
    emptyBottles: 0,   // ignored: always exactly 2 empty slots
    seed: 'legacy-knobs',
  };
  const puzzle = CP.generatePuzzle(config, { timeBudgetMs: 2000 });
  assert.equal(puzzle.state.length, colors.length + 2);
  const counts = {};
  puzzle.state.forEach((b) => b.forEach((c) => { counts[c] = (counts[c] || 0) + 1; }));
  colors.forEach((c, idx) => assert.equal(counts[idx] || 0, 4, 'per-color count field must be ignored; count is always capacity'));
});

test('difficulty ordering: expert averages longer solutions and higher scores than easy', () => {
  const colors = makeColors(8);
  const totals = { easy: [], expert: [] };
  for (let seed = 1; seed <= 10; seed++) {
    for (const difficulty of ['easy', 'expert']) {
      const config = { capacity: 4, colors, difficulty, seed };
      const puzzle = CP.generatePuzzle(config, { timeBudgetMs: 3000 });
      totals[difficulty].push(puzzle.score.moves);
    }
  }
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  assert.ok(avg(totals.expert) > avg(totals.easy),
    'expert avg ' + avg(totals.expert) + ' should exceed easy avg ' + avg(totals.easy));
});

test('scoreDifficulty returns a shape with moves/nodes/label', () => {
  const rules = { capacity: 4 };
  const state = [[0, 1, 1, 0], [1, 0, 0, 1], []];
  const score = CP.scoreDifficulty(state, rules);
  assert.equal(typeof score.moves, 'number');
  assert.equal(typeof score.nodes, 'number');
  assert.ok(['easy', 'medium', 'hard', 'expert'].includes(score.label));
});

test('encodePuzzle / decodePuzzle round-trip', () => {
  const config = { capacity: 4, colors: makeColors(4), difficulty: 'medium', seed: 'enc-test' };
  const puzzle = CP.generatePuzzle(config);
  const encoded = CP.encodePuzzle(puzzle);
  assert.equal(typeof encoded, 'string');
  assert.ok(!/[+/=]/.test(encoded), 'encoded string should be URL-hash safe');
  const decoded = CP.decodePuzzle(encoded);
  assert.deepEqual(decoded.state, puzzle.state);
  assert.equal(decoded.rules.capacity, puzzle.rules.capacity);
  assert.equal(decoded.rules.pourMode, puzzle.rules.pourMode);
  assert.deepEqual(decoded.colors, puzzle.colors);
  assert.equal(String(decoded.seed), String(puzzle.seed));
  assert.equal(decoded.difficulty, puzzle.difficulty);
});

// -----------------------------------------------------------------------
// Puzzle "quality" (realistic mixing): a generated board shouldn't look
// pre-sorted at medium+ difficulty, and hard/expert boards shouldn't have
// long untouched same-color runs sitting around.
// -----------------------------------------------------------------------

function maxRunLength(bottle) {
  if (bottle.length === 0) return 0;
  let max = 1, cur = 1;
  for (let i = 1; i < bottle.length; i++) {
    if (bottle[i] === bottle[i - 1]) cur++; else cur = 1;
    if (cur > max) max = cur;
  }
  return max;
}

function hasPreSolvedBottle(state) {
  return state.some((b) => b.length > 0 && b.every((c) => c === b[0]));
}

test('quality: no pre-sorted bottle at medium+ difficulty, for the default kit across seeds', () => {
  const colors = makeColors(8);
  for (const difficulty of ['medium', 'hard', 'expert']) {
    for (let seed = 1; seed <= 8; seed++) {
      const puzzle = CP.generatePuzzle({ capacity: 4, colors, difficulty, seed }, { timeBudgetMs: 2000 });
      assert.equal(
        hasPreSolvedBottle(puzzle.state), false,
        difficulty + ' seed=' + seed + ' has a pre-sorted bottle: ' + JSON.stringify(puzzle.state)
      );
    }
  }
});

test('quality: hard/expert boards keep same-color runs short for the default kit across seeds', () => {
  const colors = makeColors(8);
  for (const difficulty of ['hard', 'expert']) {
    for (let seed = 1; seed <= 8; seed++) {
      const puzzle = CP.generatePuzzle({ capacity: 4, colors, difficulty, seed }, { timeBudgetMs: 2000 });
      const worst = Math.max(...puzzle.state.map(maxRunLength));
      assert.ok(
        worst <= 2, difficulty + ' seed=' + seed + ' has a run of ' + worst + ' (expected <=2): ' + JSON.stringify(puzzle.state)
      );
    }
  }
});

test('quality: generation for the default kit and the 12-color kit stays well under budget', () => {
  const defaultColors = makeColors(8);
  const bigColors = makeColors(12);
  for (const colors of [defaultColors, bigColors]) {
    for (const difficulty of ['easy', 'medium', 'hard', 'expert']) {
      const t0 = Date.now();
      CP.generatePuzzle({ capacity: 4, colors, difficulty, seed: 'timing-check' }, { timeBudgetMs: 2000 });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 2000, difficulty + ' took ' + elapsed + 'ms, expected < 2000ms budget');
    }
  }
});
