'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const CP = require('../src/engine.js');

test('isSolved: classic case, all colors == capacity', () => {
  const rules = { capacity: 3 };
  assert.equal(CP.isSolved([[0, 0, 0], [1, 1, 1], []], rules), true);
  assert.equal(CP.isSolved([[0, 0, 0], [1, 1], []], rules), true); // partial bottle count<H is fine
  assert.equal(CP.isSolved([[0, 0, 1], [1, 1], []], rules), false); // mixed bottle
});

test('isSolved: color with count > capacity must span ceil(n/H) bottles, no more', () => {
  const rules = { capacity: 3 };
  // color 0 has 5 blocks -> needs ceil(5/3) = 2 bottles
  const solved = [[0, 0, 0], [0, 0], []];
  assert.equal(CP.isSolved(solved, rules), true);

  // same color split across THREE bottles when two would do -> not solved
  const overSplit = [[0, 0], [0, 0], [0], []];
  assert.equal(CP.isSolved(overSplit, rules), false);
});

test('isSolved: color split across two bottles when it could fit in one is not solved', () => {
  const rules = { capacity: 4 };
  // color 0 has 3 blocks, capacity 4 -> needs only 1 bottle
  const splitUnnecessarily = [[0, 0], [0], []];
  assert.equal(CP.isSolved(splitUnnecessarily, rules), false);
  const consolidated = [[0, 0, 0], [], []];
  assert.equal(CP.isSolved(consolidated, rules), true);
});

test('isSolved: empty state and all-empty bottles are solved', () => {
  const rules = { capacity: 4 };
  assert.equal(CP.isSolved([[], [], []], rules), true);
});

test('canonicalKey is order-independent', () => {
  const a = [[0, 0], [1], []];
  const b = [[1], [], [0, 0]];
  assert.equal(CP.canonicalKey(a), CP.canonicalKey(b));
  const c = [[0], [1], []];
  assert.notEqual(CP.canonicalKey(a), CP.canonicalKey(c));
});

test('validateState flags over-capacity and bad color indices', () => {
  const rules = { capacity: 2 };
  const r1 = CP.validateState([[0, 0, 0], [1]], rules);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.length > 0);

  const r2 = CP.validateState([[0, 1], [1]], rules);
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.errors, []);

  const r3 = CP.validateState([[0, -1]], rules);
  assert.equal(r3.ok, false);
});
