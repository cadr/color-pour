(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ColorPour = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Basic rules helpers
  // ---------------------------------------------------------------------

  function normRules(rules) {
    rules = rules || {};
    if (!Number.isInteger(rules.capacity) || rules.capacity < 1) {
      throw new Error('rules.capacity must be a positive integer');
    }
    var pourMode = rules.pourMode === 'strict' ? 'strict' : 'classic';
    return { capacity: rules.capacity, pourMode: pourMode };
  }

  function topRun(bottle) {
    if (!bottle || bottle.length === 0) return null;
    var top = bottle[bottle.length - 1];
    var count = 1;
    for (var i = bottle.length - 2; i >= 0; i--) {
      if (bottle[i] === top) count++;
      else break;
    }
    return { color: top, count: count };
  }

  function free(bottle, capacity) {
    return capacity - bottle.length;
  }

  function canPour(state, from, to, rules) {
    rules = normRules(rules);
    if (from === to) return false;
    if (from < 0 || to < 0 || from >= state.length || to >= state.length) return false;
    var a = state[from], b = state[to];
    var runA = topRun(a);
    if (!runA) return false; // from empty
    if (b.length >= rules.capacity) return false; // to full
    if (b.length > 0) {
      var runB = topRun(b);
      if (runB.color !== runA.color) return false;
    }
    if (rules.pourMode === 'strict') {
      if (runA.count > free(b, rules.capacity)) return false;
    }
    return true;
  }

  function pour(state, from, to, rules) {
    rules = normRules(rules);
    if (!canPour(state, from, to, rules)) return null;
    var a = state[from], b = state[to];
    var runA = topRun(a);
    var moveCount = Math.min(runA.count, free(b, rules.capacity));
    var newA = a.slice(0, a.length - moveCount);
    var newB = b.concat(new Array(moveCount).fill(runA.color));
    var newState = state.slice();
    newState[from] = newA;
    newState[to] = newB;
    return {
      state: newState,
      move: { from: from, to: to, count: moveCount, color: runA.color }
    };
  }

  function isPointlessMove(state, from, to) {
    var a = state[from], b = state[to];
    if (b.length === 0) {
      // moving from a bottle that is entirely one color into an empty bottle
      // accomplishes nothing.
      if (a.length > 0) {
        var run = topRun(a);
        if (run.count === a.length) return true;
      }
    }
    return false;
  }

  function legalMoves(state, rules) {
    rules = normRules(rules);
    var moves = [];
    for (var from = 0; from < state.length; from++) {
      if (state[from].length === 0) continue;
      for (var to = 0; to < state.length; to++) {
        if (from === to) continue;
        if (!canPour(state, from, to, rules)) continue;
        if (isPointlessMove(state, from, to)) continue;
        var runA = topRun(state[from]);
        var moveCount = rules.pourMode === 'strict'
          ? runA.count
          : Math.min(runA.count, free(state[to], rules.capacity));
        moves.push({ from: from, to: to, count: moveCount, color: runA.color });
      }
    }
    return moves;
  }

  function isSolved(state, rules) {
    rules = normRules(rules);
    var totals = {}; // color -> total blocks
    var bottleCounts = {}; // color -> number of bottles containing it
    for (var i = 0; i < state.length; i++) {
      var bottle = state[i];
      if (bottle.length === 0) continue;
      var first = bottle[0];
      for (var j = 1; j < bottle.length; j++) {
        if (bottle[j] !== first) return false; // not monochrome
      }
      totals[first] = (totals[first] || 0) + bottle.length;
      bottleCounts[first] = (bottleCounts[first] || 0) + 1;
    }
    for (var color in totals) {
      var required = Math.ceil(totals[color] / rules.capacity);
      if (bottleCounts[color] !== required) return false;
    }
    return true;
  }

  function canonicalKey(state) {
    var strs = state.map(function (b) { return b.join(','); });
    strs.sort();
    return strs.join('|');
  }

  function validateState(state, rules) {
    var errors = [];
    var r;
    try {
      r = normRules(rules);
    } catch (e) {
      return { ok: false, errors: [e.message] };
    }
    if (!Array.isArray(state)) {
      return { ok: false, errors: ['state must be an array of bottles'] };
    }
    state.forEach(function (bottle, idx) {
      if (!Array.isArray(bottle)) {
        errors.push('bottle ' + idx + ' is not an array');
        return;
      }
      if (bottle.length > r.capacity) {
        errors.push('bottle ' + idx + ' exceeds capacity (' + bottle.length + ' > ' + r.capacity + ')');
      }
      bottle.forEach(function (c) {
        if (!Number.isInteger(c) || c < 0) {
          errors.push('bottle ' + idx + ' has invalid color index ' + c);
        }
      });
    });
    return { ok: errors.length === 0, errors: errors };
  }

  // ---------------------------------------------------------------------
  // Solver
  // ---------------------------------------------------------------------

  // Min-heap keyed by f value.
  function MinHeap() {
    this.items = [];
  }
  MinHeap.prototype.push = function (item) {
    var items = this.items;
    items.push(item);
    var i = items.length - 1;
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (items[parent].f <= items[i].f) break;
      var tmp = items[parent]; items[parent] = items[i]; items[i] = tmp;
      i = parent;
    }
  };
  MinHeap.prototype.pop = function () {
    var items = this.items;
    var top = items[0];
    var last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      var i = 0;
      var n = items.length;
      while (true) {
        var l = 2 * i + 1, rr = 2 * i + 2, smallest = i;
        if (l < n && items[l].f < items[smallest].f) smallest = l;
        if (rr < n && items[rr].f < items[smallest].f) smallest = rr;
        if (smallest === i) break;
        var tmp = items[smallest]; items[smallest] = items[i]; items[i] = tmp;
        i = smallest;
      }
    }
    return top;
  };
  MinHeap.prototype.size = function () { return this.items.length; };

  function heuristic(state, rules) {
    // breaks: contiguous-color boundaries within each bottle (admissible-ish
    // lower bound: each pour removes at most one such boundary at the source).
    // Single pass over all blocks (no per-color filtering) for speed, since
    // this runs once per expanded search node.
    var breaks = 0;
    var totalsByColor = {};
    var monoBottlesByColor = {};
    var mixedColors = {};
    for (var i = 0; i < state.length; i++) {
      var bottle = state[i];
      if (bottle.length === 0) continue;
      var first = bottle[0];
      var mono = true;
      for (var j = 0; j < bottle.length; j++) {
        var c = bottle[j];
        totalsByColor[c] = (totalsByColor[c] || 0) + 1;
        if (j > 0 && bottle[j - 1] !== c) { breaks++; mono = false; }
      }
      if (mono) {
        monoBottlesByColor[first] = (monoBottlesByColor[first] || 0) + 1;
      } else {
        for (var k = 0; k < bottle.length; k++) mixedColors[bottle[k]] = true;
      }
    }
    // Fragmentation: only counted for colors that already sit in monochrome
    // bottles (colors that are still mixed already get charged via `breaks`).
    var frag = 0;
    for (var col in monoBottlesByColor) {
      if (mixedColors[col]) continue; // already charged by breaks
      var n = totalsByColor[col] || 0;
      var required = Math.ceil(n / rules.capacity);
      var used = monoBottlesByColor[col];
      if (used > required) frag += used - required;
    }
    return breaks + frag;
  }

  // Internal fast-path move generation/application used only inside the
  // search loop: skips normRules() (called once per candidate move by the
  // public canPour/pour) and the redundant re-validation pour() does via
  // canPour(), since legalMoves has already established these moves are
  // legal. This matters a lot here — it's called on every expanded node.
  function fastLegalMoves(state, capacity, pourMode) {
    var moves = [];
    for (var from = 0; from < state.length; from++) {
      var a = state[from];
      if (a.length === 0) continue;
      var runA = topRun(a);
      for (var to = 0; to < state.length; to++) {
        if (to === from) continue;
        var b = state[to];
        if (b.length >= capacity) continue;
        if (b.length > 0 && b[b.length - 1] !== runA.color) continue;
        var freeB = capacity - b.length;
        if (pourMode === 'strict' && runA.count > freeB) continue;
        if (b.length === 0 && runA.count === a.length) continue; // pointless prune
        var moveCount = pourMode === 'strict' ? runA.count : Math.min(runA.count, freeB);
        moves.push({ from: from, to: to, count: moveCount, color: runA.color });
      }
    }
    return moves;
  }

  function fastApplyMove(state, move) {
    var newState = state.slice();
    var a = state[move.from], b = state[move.to];
    newState[move.from] = a.slice(0, a.length - move.count);
    newState[move.to] = b.concat(new Array(move.count).fill(move.color));
    return newState;
  }

  function solve(state, rules, opts) {
    rules = normRules(rules);
    opts = opts || {};
    var maxNodes = opts.maxNodes || 200000;
    var optimal = !!opts.optimal;
    // Non-optimal mode uses a heavily-weighted (greedy) heuristic: our
    // `heuristic()` badly underestimates true distance-to-goal on larger,
    // more mixed boards, so a low weight (close to admissible/uniform-cost)
    // makes A* degenerate into near-exhaustive search (tens of thousands of
    // nodes even on solvable 14-bottle boards). A higher weight trades a
    // somewhat longer (non-optimal) solution for a dramatically smaller
    // search — verified empirically to cut node counts by ~1000x on
    // representative boards while only lengthening solutions ~30-40%.
    var weight = optimal ? 1 : (opts.weight || 4);
    var capacity = rules.capacity, pourMode = rules.pourMode;

    if (isSolved(state, rules)) {
      return { solvable: true, moves: [], nodes: 0, optimal: optimal };
    }

    var startKey = canonicalKey(state);
    // Track the best (lowest) g found so far for each canonical state, not
    // just whether it's been seen. Marking a state "done" the first time
    // it's pushed (rather than tracking cost) can discard a later path
    // that reaches the same state more cheaply, which breaks A*'s
    // optimality guarantee whenever two different paths reach the same
    // state with different costs (common here, since many move orders
    // commute). Nodes are also lazily skipped on pop if a cheaper path to
    // the same state was found after they were queued.
    //
    // Paths are reconstructed via parent pointers (rather than each node
    // carrying its own full move-list copy) to avoid O(path length) array
    // copies on every single successor generated.
    var bestG = new Map();
    var heap = new MinHeap();
    heap.push({ state: state, parent: null, move: null, g: 0, f: heuristic(state, rules) * weight, key: startKey });
    bestG.set(startKey, 0);
    var nodes = 0;

    while (heap.size() > 0) {
      if (nodes >= maxNodes) {
        return { solvable: null, moves: null, nodes: nodes, optimal: optimal };
      }
      var node = heap.pop();
      if (node.g > bestG.get(node.key)) continue; // stale, superseded by a cheaper path
      nodes++;
      if (isSolved(node.state, rules)) {
        var moves = [];
        var cur = node;
        while (cur.parent) { moves.push(cur.move); cur = cur.parent; }
        moves.reverse();
        return { solvable: true, moves: moves, nodes: nodes, optimal: optimal };
      }
      var legal = fastLegalMoves(node.state, capacity, pourMode);
      for (var i = 0; i < legal.length; i++) {
        var mv = legal[i];
        var newState = fastApplyMove(node.state, mv);
        var key = canonicalKey(newState);
        var g = node.g + 1;
        if (bestG.has(key) && bestG.get(key) <= g) continue;
        bestG.set(key, g);
        var h = heuristic(newState, rules);
        heap.push({ state: newState, parent: node, move: mv, g: g, f: g + h * weight, key: key });
      }
    }

    return { solvable: false, moves: null, nodes: nodes, optimal: optimal };
  }

  // ---------------------------------------------------------------------
  // PRNG
  // ---------------------------------------------------------------------

  function hashSeed(seed) {
    var str = String(seed);
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rngFromSeed(seed) {
    var s = hashSeed(seed == null ? Date.now() + '_' + Math.random() : seed);
    return mulberry32(s);
  }

  // ---------------------------------------------------------------------
  // Puzzle generation
  // ---------------------------------------------------------------------

  function shuffle(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  // Matches the physical kit's rules: the user only picks the number of
  // distinct colors (N, i.e. config.colors.length) and the slot height H
  // (config.capacity). Everything else is derived:
  //   - slots (bottles) = N + 2, always.
  //   - exactly 2 slots start empty; the other N slots are each completely
  //     full (H blocks of one color), so every color appears exactly H
  //     times. There is no user-chosen slot count, empty-slot count, partial
  //     fill level, or per-color block count.
  function validateGenerateConfig(config) {
    if (!config || typeof config !== 'object') throw new Error('config is required');
    if (!Number.isInteger(config.capacity) || config.capacity < 2) {
      throw new Error('config.capacity (slot height) must be an integer >= 2 (height 1 slots can never be scrambled into an unsolved puzzle)');
    }
    if (!Array.isArray(config.colors) || config.colors.length < 2) {
      // With a single color there is nothing to scramble while keeping the
      // fixed invariant: the lone color's H blocks must fill exactly one
      // slot completely, which is already "solved" by definition.
      throw new Error('config.colors must include at least 2 distinct colors (one entry per color, {name, hex})');
    }
    config.colors.forEach(function (c, idx) {
      if (!c || typeof c.name !== 'string' || !c.name.trim()) {
        throw new Error('color at index ' + idx + ' must have a non-empty name');
      }
    });
    var numColors = config.colors.length;
    return {
      bottles: numColors + 2,
      totalBlocks: numColors * config.capacity
    };
  }

  function seq(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(i);
    return out;
  }

  // The ONLY generation strategy: shuffle every block (all N colors, H each)
  // into one pile and deal them out — like physically dumping every block in
  // and pouring it into slots at random. This is the ONLY approach that can
  // preserve the physical kit's fixed invariant (exactly `emptyBottles` slots
  // stay empty; every other slot ends up COMPLETELY full at capacity): an
  // "un-pour" scramble of a solved layout would necessarily leave some slots
  // partially filled, which the real kit's tubes can't represent (a slot is
  // either an untouched full tube or one of the empty ones). Not every deal
  // is solvable, so callers must verify with solve(); empirically the large
  // majority of deals for realistic kit sizes ARE solvable, since two empty
  // slots give plenty of room to maneuver.
  function randomDealState(config, totalBlocks, emptyBottles, rng) {
    var blocks = [];
    config.colors.forEach(function (c, idx) {
      for (var i = 0; i < c.count; i++) blocks.push(idx);
    });
    blocks = shuffle(blocks, rng);

    var usedBottles = config.bottles - emptyBottles;
    // The empty slots are always the LAST `emptyBottles` positions, so the
    // puzzle view can omit them (the player knows the trailing slots start
    // empty) and the full slots fit on one row on narrow screens.
    var order = seq(config.bottles);
    var state = [];
    for (var i = 0; i < config.bottles; i++) state.push([]);
    var bi = 0, guard = 0;
    var maxGuard = blocks.length * config.bottles + config.bottles + 10;
    for (var k = 0; k < blocks.length; k++) {
      while (state[order[bi % usedBottles]].length >= config.capacity) {
        bi++;
        guard++;
        if (guard > maxGuard) throw new Error('internal error dealing blocks (random deal)');
      }
      state[order[bi % usedBottles]].push(blocks[k]);
      bi++;
    }
    return state;
  }

  function bottleMaxRun(bottle) {
    if (bottle.length === 0) return 0;
    var max = 1, cur = 1;
    for (var i = 1; i < bottle.length; i++) {
      if (bottle[i] === bottle[i - 1]) cur++; else cur = 1;
      if (cur > max) max = cur;
    }
    return max;
  }

  function isMonochrome(bottle) {
    if (bottle.length === 0) return false;
    for (var i = 1; i < bottle.length; i++) if (bottle[i] !== bottle[0]) return false;
    return true;
  }

  // Quality gate applied to candidate layouts before we bother solving them:
  // rejects boards that already "look solved" (a pre-sorted bottle) or that
  // are too gentle (long same-color runs) for the requested difficulty.
  function meetsQuality(state, quality) {
    for (var i = 0; i < state.length; i++) {
      var bottle = state[i];
      if (bottle.length === 0) continue;
      if (!quality.allowPreSolved && isMonochrome(bottle)) return false;
      if (bottleMaxRun(bottle) > quality.maxRun) return false;
    }
    return true;
  }

  function qualityForDifficulty(difficulty, capacity) {
    if (difficulty === 'easy') {
      return { maxRun: capacity, allowPreSolved: true };
    }
    if (difficulty === 'medium') {
      return { maxRun: Math.max(2, Math.min(capacity - 1, 3)), allowPreSolved: false };
    }
    // hard / expert
    return { maxRun: Math.max(1, Math.min(capacity - 2, 2)), allowPreSolved: false };
  }

  function relaxQuality(quality, capacity) {
    if (quality.maxRun < capacity) {
      return { maxRun: quality.maxRun + 1, allowPreSolved: quality.allowPreSolved };
    }
    return { maxRun: capacity, allowPreSolved: true };
  }

  function labelForScore(ratio) {
    if (ratio < 0.62) return 'easy';
    if (ratio < 0.75) return 'medium';
    if (ratio < 0.85) return 'hard';
    return 'expert';
  }

  var DIFFICULTY_TARGET_RATIO = { easy: 0.55, medium: 0.72, hard: 0.85, expert: 1.0 };

  function buildScore(state, moveCount, nodes) {
    var totalBlocks = 0;
    state.forEach(function (b) { totalBlocks += b.length; });
    var ratio = totalBlocks > 0 ? moveCount / totalBlocks : 0;
    var emptyBottles = state.filter(function (b) { return b.length === 0; }).length;
    // fewer empties -> push toward harder label
    var adjRatio = ratio + Math.max(0, (2 - emptyBottles)) * 0.15;
    var deadEndRatio = moveCount > 0 ? nodes / moveCount : nodes;
    return {
      moves: moveCount,
      nodes: nodes,
      deadEndRatio: deadEndRatio,
      label: labelForScore(adjRatio)
    };
  }

  function scoreDifficulty(state, rules, solution) {
    rules = normRules(rules);
    var moves, nodes;
    if (solution) {
      moves = solution;
      nodes = 0;
    } else {
      var sr = solve(state, rules, { maxNodes: 200000, optimal: false });
      moves = sr.moves || [];
      nodes = sr.nodes;
    }
    return buildScore(state, moves.length, nodes);
  }

  function generatePuzzle(config, opts) {
    opts = opts || {};
    var maxAttempts = opts.maxAttempts || 40;
    var timeBudgetMs = opts.timeBudgetMs != null ? opts.timeBudgetMs : 1500;
    var difficulty = config.difficulty || 'medium';
    if (['easy', 'medium', 'hard', 'expert'].indexOf(difficulty) === -1) {
      throw new Error('difficulty must be one of easy, medium, hard, expert');
    }
    var rules = normRules({ capacity: config.capacity, pourMode: config.pourMode });
    var validated = validateGenerateConfig(config);
    var totalBlocks = validated.totalBlocks;

    // Derived, not user-configurable: slots = colors + 2, exactly 2 of them
    // start empty, and every other slot is completely full (H blocks each),
    // so each color appears exactly H times. This matches the physical kit,
    // which only exposes "number of colors" and "slot height" as choices.
    var genConfig = {
      bottles: validated.bottles,
      capacity: rules.capacity,
      colors: config.colors.map(function (c) { return { name: c.name, hex: c.hex, count: rules.capacity }; })
    };
    var emptyBottles = 2;

    var seed = config.seed != null ? config.seed : Math.floor(Math.random() * 1e9);
    // mix the difficulty into the rng stream so different difficulty bands
    // (which often share the same emptyBottles count for small configs)
    // still explore distinct candidate layouts rather than replaying the
    // exact same shuffle sequence.
    var rng = rngFromSeed(String(seed) + ':' + difficulty);
    var targetRatio = DIFFICULTY_TARGET_RATIO[difficulty];
    var quality = qualityForDifficulty(difficulty, rules.capacity);

    // Bound each candidate's verification cost so a single hard-to-solve
    // (or unsolvable) candidate can't blow the whole time budget. Scales up
    // with puzzle size so larger boards still get a fair shot at resolving.
    var quickMaxNodes = opts.quickMaxNodes || Math.min(120000, 15000 + totalBlocks * 1500);
    // "close enough" to the difficulty's target ratio that we shouldn't keep
    // burning budget looking for a marginally better match.
    var GOOD_ENOUGH_DIST = 0.08;

    var start = Date.now();
    var deadline = start + timeBudgetMs;
    // `maxAttempts` limits the number of (expensive) solve() calls, not the
    // number of candidate layouts generated — generating + quality-checking
    // a layout is cheap and shouldn't be capped by the same budget.
    var solveAttempts = 0;
    var dealAttempts = 0;
    var maxDealAttempts = Math.max(maxAttempts * 20, 4000);

    var bestConforming = null, bestConformingDist = Infinity;
    var bestAny = null, bestAnyDist = Infinity; // safety net: solvable, quality ignored

    function consider(state, forceSolve) {
      if (isSolved(state, rules)) return false;
      var passesQuality = meetsQuality(state, quality);
      if (!passesQuality && !forceSolve) return false;
      if (solveAttempts >= maxAttempts) return false;
      solveAttempts++;
      var quick = solve(state, rules, { maxNodes: quickMaxNodes, optimal: false });
      if (!quick.solvable) return false;
      var score = scoreDifficulty(state, rules, quick.moves);
      var ratio = totalBlocks > 0 ? score.moves / totalBlocks : 0;
      var dist = Math.abs(ratio - targetRatio);
      if (dist < bestAnyDist) {
        bestAnyDist = dist;
        bestAny = { state: state, quick: quick, score: score };
      }
      if (passesQuality && dist < bestConformingDist) {
        bestConformingDist = dist;
        bestConforming = { state: state, quick: quick, score: score };
        return dist < GOOD_ENOUGH_DIST;
      }
      return false;
    }

    // Random deal (shuffle all blocks, fill the N full slots, leave the 2
    // empty ones) — the only strategy that preserves the physical kit's
    // fixed invariant (see randomDealState). Not every deal is solvable, so
    // every candidate is verified; the quality gate below is cheap to check
    // and avoids wasting solve() calls on obviously-bad boards unless we
    // still have no solvable fallback at all.
    while (dealAttempts < maxDealAttempts && solveAttempts < maxAttempts && Date.now() < deadline) {
      dealAttempts++;
      var forceSolve = !bestAny && (dealAttempts % 5 === 0);
      var done = consider(randomDealState(genConfig, totalBlocks, emptyBottles, rng), forceSolve);
      if (done && dealAttempts >= 5) break;
    }

    // If we still don't have a quality-conforming candidate, relax the
    // quality gate (looser run-length cap, eventually allowing pre-solved
    // bottles) and try more random deals with whatever time is left, rather
    // than silently shipping a too-easy/pre-sorted board or (worse) failing
    // outright when a solvable-but-imperfect candidate (bestAny) exists.
    var relaxed = quality;
    while (
      !bestConforming && !relaxed.allowPreSolved && Date.now() < deadline &&
      solveAttempts < maxAttempts && relaxed.maxRun < rules.capacity + 1
    ) {
      relaxed = relaxQuality(relaxed, rules.capacity);
      quality = relaxed;
      var relaxRoundEnd = Math.min(deadline, Date.now() + Math.max(50, timeBudgetMs * 0.15));
      // Cap iterations too, not just wall time: if every candidate is
      // rejected instantly (e.g. a degenerate config that's always already
      // "solved"), the loop would otherwise busy-spin for the whole time
      // window doing no useful work.
      var roundIters = 0;
      while (solveAttempts < maxAttempts && roundIters < 500 && Date.now() < relaxRoundEnd) {
        roundIters++;
        consider(randomDealState(genConfig, totalBlocks, emptyBottles, rng), true);
      }
    }

    var best = bestConforming || bestAny;
    if (!best) {
      throw new Error('Could not generate a solvable puzzle for the given configuration within the time budget');
    }

    // try to get a nicer (ideally optimal) solution for display, bounded,
    // but only if there's meaningful time left in the budget.
    var finalSolution = best.quick.moves;
    var finalNodes = best.quick.nodes;
    var remaining = deadline - Date.now();
    if (remaining > 50) {
      var optimalMaxNodes = Math.max(4000, Math.min(40000, remaining * 40));
      var optimalTry = solve(best.state, rules, { maxNodes: optimalMaxNodes, optimal: true });
      if (optimalTry.solvable === true && optimalTry.moves.length <= finalSolution.length) {
        finalSolution = optimalTry.moves;
        finalNodes = optimalTry.nodes;
      }
    }

    var finalScore = buildScore(best.state, finalSolution.length, finalNodes);

    return {
      state: best.state,
      rules: rules,
      colors: genConfig.colors, // each color's count === capacity (H)
      seed: seed,
      difficulty: difficulty,
      solution: finalSolution,
      score: finalScore,
      config: config
    };
  }

  function applyMoves(state, moves, rules) {
    rules = normRules(rules);
    var states = [state];
    var current = state;
    for (var i = 0; i < moves.length; i++) {
      var mv = moves[i];
      var result = pour(current, mv.from, mv.to, rules);
      if (!result) throw new Error('illegal move at step ' + i + ': ' + JSON.stringify(mv));
      current = result.state;
      states.push(current);
    }
    return states;
  }

  // ---------------------------------------------------------------------
  // Encode / decode
  // ---------------------------------------------------------------------

  function b64encode(str) {
    var bytes = encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    });
    var b64;
    if (typeof btoa === 'function') {
      b64 = btoa(bytes);
    } else {
      b64 = Buffer.from(bytes, 'binary').toString('base64');
    }
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64decode(str) {
    var b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bytes;
    if (typeof atob === 'function') {
      bytes = atob(b64);
    } else {
      bytes = Buffer.from(b64, 'base64').toString('binary');
    }
    var percentEncoded = bytes.split('').map(function (c) {
      var code = c.charCodeAt(0).toString(16).padStart(2, '0');
      return '%' + code;
    }).join('');
    return decodeURIComponent(percentEncoded);
  }

  function encodePuzzle(puzzle) {
    var payload = {
      b: puzzle.state,
      c: puzzle.rules.capacity,
      m: puzzle.rules.pourMode,
      cl: puzzle.colors,
      s: puzzle.seed,
      d: puzzle.difficulty,
      sol: puzzle.solution
    };
    return b64encode(JSON.stringify(payload));
  }

  function decodePuzzle(str) {
    var payload = JSON.parse(b64decode(str));
    return {
      state: payload.b,
      rules: { capacity: payload.c, pourMode: payload.m || 'classic' },
      colors: payload.cl,
      seed: payload.s,
      difficulty: payload.d,
      solution: payload.sol || null
    };
  }

  return {
    topRun: topRun,
    canPour: canPour,
    pour: pour,
    legalMoves: legalMoves,
    isSolved: isSolved,
    canonicalKey: canonicalKey,
    validateState: validateState,
    solve: solve,
    rngFromSeed: rngFromSeed,
    generatePuzzle: generatePuzzle,
    scoreDifficulty: scoreDifficulty,
    applyMoves: applyMoves,
    encodePuzzle: encodePuzzle,
    decodePuzzle: decodePuzzle
  };
});
