'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const CP = require('../src/engine.js');

// Plain BFS reference solver used only to cross-check optimality on small
// cases (kept intentionally dumb: no heuristic, no pruning, just shortest
// path over legal moves).
function bfsShortest(state, rules, maxNodes) {
  const startKey = CP.canonicalKey(state);
  if (CP.isSolved(state, rules)) return 0;
  let frontier = [state];
  const seen = new Set([startKey]);
  let depth = 0;
  let nodes = 0;
  while (frontier.length > 0) {
    depth++;
    const next = [];
    for (const s of frontier) {
      const moves = CP.legalMoves(s, rules);
      for (const mv of moves) {
        const res = CP.pour(s, mv.from, mv.to, rules);
        if (!res) continue;
        nodes++;
        if (nodes > maxNodes) throw new Error('bfs exceeded maxNodes');
        const key = CP.canonicalKey(res.state);
        if (seen.has(key)) continue;
        seen.add(key);
        if (CP.isSolved(res.state, rules)) return depth;
        next.push(res.state);
      }
    }
    frontier = next;
    if (frontier.length === 0) return null; // unsolvable
  }
  return null;
}

test('solve: a small known-solvable puzzle reaches solved and replays correctly', () => {
  const rules = { capacity: 4 };
  const state = [
    [0, 1, 0, 1],
    [1, 0, 1, 0],
    [],
  ];
  const result = CP.solve(state, rules, { optimal: true });
  assert.equal(result.solvable, true);
  assert.ok(Array.isArray(result.moves));
  const states = CP.applyMoves(state, result.moves, rules);
  assert.equal(CP.isSolved(states[states.length - 1], rules), true);
  // moves reference original indices: from/to must be valid indices into `state`
  for (const mv of result.moves) {
    assert.ok(mv.from >= 0 && mv.from < state.length);
    assert.ok(mv.to >= 0 && mv.to < state.length);
  }
});

test('solve: a known-unsolvable puzzle returns solvable:false', () => {
  const rules = { capacity: 2 };
  // classic unsolvable 2-bottle swap: no empty bottle, colors interlocked
  const state = [[0, 1], [1, 0]];
  const result = CP.solve(state, rules, { optimal: true });
  assert.equal(result.solvable, false);
  assert.equal(result.moves, null);
});

test('solve: already-solved state returns solvable:true with zero moves', () => {
  const rules = { capacity: 3 };
  const state = [[0, 0, 0], [1, 1], []];
  const result = CP.solve(state, rules);
  assert.equal(result.solvable, true);
  assert.deepEqual(result.moves, []);
});

test('solve: optimal mode matches a plain BFS shortest path on small cases', () => {
  const rules = { capacity: 3, pourMode: 'classic' };
  const cases = [
    [[0, 1, 2], [1, 2, 0], [2, 0, 1], []],
    [[0, 0, 1], [1, 1, 0], []],
    [[0, 1, 1], [1, 0, 0], []],
  ];
  for (const state of cases) {
    const bfsLen = bfsShortest(state, rules, 200000);
    const result = CP.solve(state, rules, { optimal: true, maxNodes: 200000 });
    if (bfsLen === null) {
      assert.equal(result.solvable, false, 'expected unsolvable to match BFS');
    } else {
      assert.equal(result.solvable, true);
      assert.equal(result.moves.length, bfsLen, 'optimal solver should match BFS shortest length');
      const states = CP.applyMoves(state, result.moves, rules);
      assert.equal(CP.isSolved(states[states.length - 1], rules), true);
    }
  }
});

test('solve: respects maxNodes and returns solvable:null when exceeded', () => {
  const rules = { capacity: 4 };
  // A larger, harder puzzle with a tiny node budget should hit the limit.
  const state = [
    [0, 1, 2, 3], [1, 2, 3, 0], [2, 3, 0, 1], [3, 0, 1, 2],
    [0, 1, 2, 3], [1, 2, 3, 0], [], [],
  ];
  const result = CP.solve(state, rules, { maxNodes: 2 });
  assert.equal(result.solvable, null);
  assert.equal(result.moves, null);
  assert.ok(result.nodes >= 2);
});

test('solve: moves array from a non-optimal solve also replays to solved', () => {
  const rules = { capacity: 4 };
  const state = [[0, 1, 1, 0], [1, 0, 0, 1], []];
  const result = CP.solve(state, rules, { optimal: false });
  assert.equal(result.solvable, true);
  const states = CP.applyMoves(state, result.moves, rules);
  assert.equal(CP.isSolved(states[states.length - 1], rules), true);
});
