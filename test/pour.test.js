'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const CP = require('../src/engine.js');

test('topRun basics', () => {
  assert.equal(CP.topRun([]), null);
  assert.deepEqual(CP.topRun([1]), { color: 1, count: 1 });
  assert.deepEqual(CP.topRun([0, 1, 1, 1]), { color: 1, count: 3 });
  assert.deepEqual(CP.topRun([1, 1, 0]), { color: 0, count: 1 });
});

test('classic pour: partial pour allowed when destination lacks full room', () => {
  const rules = { capacity: 4, pourMode: 'classic' };
  // from has a top run of 3 (color 1), dest has matching top color but only 1 free slot
  const state = [[2, 1, 1, 1], [9, 1, 1]];
  assert.equal(CP.canPour(state, 0, 1, rules), true);
  const result = CP.pour(state, 0, 1, rules);
  assert.ok(result);
  assert.equal(result.move.count, 1); // only 1 free slot in dest
  assert.deepEqual(result.state[0], [2, 1, 1]);
  assert.deepEqual(result.state[1], [9, 1, 1, 1]);
});

test('strict pour: rejected unless the entire top run fits', () => {
  const rules = { capacity: 4, pourMode: 'strict' };
  const state = [[2, 1, 1, 1], [9, 1, 1]]; // run of 3 (color 1), only 1 free slot
  assert.equal(CP.canPour(state, 0, 1, rules), false);
  assert.equal(CP.pour(state, 0, 1, rules), null);

  const state2 = [[2, 1, 1], [9, 1]]; // run of 2 (color 1), 2 free slots -> fits exactly
  assert.equal(CP.canPour(state2, 0, 1, rules), true);
  const result = CP.pour(state2, 0, 1, rules);
  assert.equal(result.move.count, 2);
});

test('pour rejects: same bottle, empty source, full destination, color mismatch', () => {
  const rules = { capacity: 3 };
  const state = [[1, 1], [], [0, 0, 0], [2]];
  assert.equal(CP.canPour(state, 0, 0, rules), false); // same bottle
  assert.equal(CP.canPour(state, 1, 0, rules), false); // empty source
  assert.equal(CP.canPour(state, 0, 2, rules), false); // full destination
  assert.equal(CP.canPour(state, 0, 3, rules), false); // color mismatch, not empty
  assert.equal(CP.canPour(state, 0, 1, rules), true); // empty destination ok
});

test('pour never mutates the input state or bottles', () => {
  const rules = { capacity: 4 };
  const state = [[1, 1, 1], []];
  const frozenCopy = JSON.parse(JSON.stringify(state));
  const result = CP.pour(state, 0, 1, rules);
  assert.deepEqual(state, frozenCopy);
  assert.notEqual(result.state, state);
  assert.notEqual(result.state[0], state[0]);
});

test('pour returns null for illegal moves', () => {
  const rules = { capacity: 2 };
  const state = [[0], [1]];
  assert.equal(CP.pour(state, 0, 1, rules), null);
});

test('legalMoves prunes moving an entirely-monochrome bottle into an empty one', () => {
  const rules = { capacity: 4 };
  const state = [[1, 1, 1], []];
  const moves = CP.legalMoves(state, rules);
  assert.equal(moves.length, 0);
});

test('legalMoves keeps useful moves and excludes illegal ones', () => {
  const rules = { capacity: 4 };
  const state = [[0, 1, 1], [1], []];
  const moves = CP.legalMoves(state, rules);
  // 0->1 (merge reds), 0->2 or 1->2 (pointless: bottle 1 is entirely one color -> empty, pruned)
  const pairs = moves.map((m) => m.from + '->' + m.to);
  assert.ok(pairs.includes('0->1'));
  assert.ok(!pairs.includes('1->2')); // bottle 1 monochrome -> empty bottle: pruned
});
