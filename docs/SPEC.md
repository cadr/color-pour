# Color Pour — Spec & Module Contract

A physical take on the classic pour-and-sort color puzzle: a plastic rack with **slots** (bottles/tubes), each
holding up to **H** stacked colored **blocks**. The app designs solvable puzzles for the user's
physical kit and can show the solution.

## Constraints
- 100% static, no backend, no build step, **no npm dependencies**. Opening `index.html` directly
  from disk (`file://`) must work → use classic `<script>` tags, NOT ES modules.
- Tests run with Node's built-in runner: `node --test` (Node 22). `package.json` has
  `"scripts": {"test": "node --test test/"}` and no dependencies.

## Files
```
index.html          UI shell (loads src/engine.js then src/app.js via classic <script>)
src/engine.js       pure game logic: rules, solver, generator (no DOM)
src/app.js          UI logic (DOM)
src/styles.css      styles
test/*.test.js      node:test tests (require('../src/engine.js'))
README.md
```

`src/engine.js` must be UMD-style:
```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ColorPour = factory();
})(typeof self !== 'undefined' ? self : this, function () { ... return { ...api }; });
```

## Domain
- **State**: `number[][]` — array of bottles; each bottle is an array of color indices,
  **index 0 = bottom**, last = top. Length ≤ capacity. Never mutate inputs; return new arrays.
- **capacity** `H`: integer ≥ 2 (typically 2–8). H=1 is rejected by `generatePuzzle` — a
  height-1 slot can only ever hold a single (trivially monochrome) block, so no puzzle built at
  that height can ever be unsolved.

### Physical setup rules (matches the real block kit)
The user only ever picks **two** settings: the number of distinct colors `N`
(`config.colors.length`) and the slot height `H` (`config.capacity`). Everything else about the
starting layout is derived, not user-configurable:
- **Slots** (bottles) = `N + 2`, always.
- **Exactly 2 slots start empty**; the other `N` slots each start **completely full** (`H` blocks).
- So each color appears **exactly `H` times** total — there is no per-color block count, no
  user-chosen slot count, no user-chosen empty-slot count, and no partial fill level.

`generatePuzzle`'s only job, given `N` colors and height `H`, is to find an arrangement of those
`N*H` blocks across the `N` full slots (2 slots forced empty) that is solvable and not already
solved, at the requested difficulty. `config.colors.length` must be ≥ 2 (a single color can't be
split while every non-empty slot must stay completely full, so it would always already be
"solved").
- **Top run** of a bottle: the maximal contiguous group of same-color blocks at the top.
- **Pour rules** (`pourMode`):
  - `'classic'` (default, matches the common digital versions): pour from A to B is legal iff A≠B, A non-empty,
    B not full, and (B empty or top(B) == top(A)). Moves `min(topRun(A), free(B))` blocks.
  - `'strict'` (all-or-nothing): same, but additionally the ENTIRE top run of A must fit in B
    (`topRun(A) <= free(B)`); moves the whole run.
  - Pointless moves are still legal per the rules but the solver should prune them (e.g. pouring a
    bottle that is entirely one color into an empty bottle).
- **Color counts vary**: a color may have any number of blocks (≥1), not necessarily H.
- **Solved**: every bottle is empty or monochrome, AND each color `c` with total count `n_c`
  occupies exactly `ceil(n_c / H)` bottles (i.e. a color is consolidated as much as possible).
  When all counts == H this reduces to the classic rule.

## Engine API (`ColorPour.*`)
```ts
type State = number[][];
type Move = { from: number, to: number, count: number, color: number };
type Rules = { capacity: number, pourMode?: 'classic' | 'strict' };

topRun(bottle: number[]): { color: number, count: number } | null
canPour(state, from, to, rules): boolean
pour(state, from, to, rules): { state: State, move: Move } | null   // null if illegal
legalMoves(state, rules): Move[]                                   // pruned of pointless moves
isSolved(state, rules): boolean
canonicalKey(state): string   // order-independent key (bottles are interchangeable)
validateState(state, rules): { ok: boolean, errors: string[] }   // over-capacity, etc.

solve(state, rules, opts?: { maxNodes?: number, optimal?: boolean })
  : { solvable: boolean | null, moves: Move[] | null, nodes: number, optimal: boolean }
  // solvable=null means search limit hit (unknown). Moves reference ORIGINAL bottle indices
  // and replaying them with pour() from `state` must reach a solved state.
  // Use A* / best-first with a heuristic + canonicalKey dedup; optimal:true uses admissible
  // heuristic (may be slow; bounded by maxNodes). Default maxNodes ~200k.

rngFromSeed(seed: number | string): () => number    // deterministic PRNG (e.g. mulberry32)

generatePuzzle(config, opts?): Puzzle | null
  config = {
    capacity: number,          // H, the slot height. Must be >= 2.
    colors: { name: string, hex: string }[],  // N distinct colors, N >= 2. No count field: every
                                               // color always uses exactly H blocks (derived).
    pourMode?: 'classic'|'strict',
    difficulty?: 'easy'|'medium'|'hard'|'expert',
    seed?: number|string,
  }
  // bottles (slots) and emptyBottles are NOT config fields — they are always derived:
  //   bottles = config.colors.length + 2; emptyBottles = 2.
  opts = { maxAttempts?: number, timeBudgetMs?: number }
  Puzzle = {
    state: State, rules: Rules, colors: {name,hex,count}[], seed, difficulty,
    solution: Move[], score: DifficultyScore, config
  }
  // `colors` on the returned Puzzle each have count === capacity (H) — every color appears
  // exactly H times in `state`.
  // Returns null (or throws a descriptive Error for impossible configs) if it can't find one.
  // Must ALWAYS return a puzzle whose `state` has exactly colors.length + 2 slots, exactly 2 of
  // them empty and the rest completely full (height H), that is solvable (verified by solve())
  // and NOT already solved.
  // Throws Error with a clear human message if: capacity < 2; colors.length < 2; any color is
  // missing a non-empty name; etc.

scoreDifficulty(state, rules, solution?): DifficultyScore
  // { moves: number, nodes: number, deadEndRatio?: number, label: 'easy'|'medium'|'hard'|'expert' }

applyMoves(state, moves, rules): State[]   // list of states after each move (incl. initial)
encodePuzzle(puzzle): string / decodePuzzle(str): puzzle-ish  // compact, URL-hash safe
```

### Difficulty (guideline — tune empirically)
Generation: shuffle all `N*H` blocks into one pile and deal them into the `N` full slots (seeded),
leaving the 2 empty slots aside — this is the ONLY generation strategy, since it's the only one
that can preserve the fixed "2 empty / N completely full" invariant (an "un-pour" scramble of a
solved layout would necessarily leave some slots partially filled, which the invariant forbids).
Not every deal is solvable, so candidates are verified with `solve()`; empirically the large
majority of deals are solvable (two empty slots give plenty of room to maneuver). Optionally reject
layouts with too many adjacent same-color blocks for harder levels. Try many candidates within the
time budget and pick the one whose score best fits the requested band. Score primarily by
optimal/near-optimal solution length relative to the number of blocks, plus solver search effort
(nodes). Easy = shorter solutions, more tolerance for long same-color runs / a pre-sorted slot;
Expert = long solutions, short same-color runs, no pre-sorted slot.

## UI requirements (src/app.js, index.html, src/styles.css)
1. **Setup panel** (persisted in localStorage, wrapped in try/catch): the user picks exactly TWO
   settings —
   - **number of colors** (N) and **slot height** (H, blocks per slot). Slots are ALWAYS N + 2
     (derived, shown as a read-only note, e.g. "Uses 6 + 2 = 8 slots"); there is no user-chosen
     slot count, empty-slot count, partial fill level, or per-color block count.
   - color list: rows of {color picker, name} only (no per-color count — every color always uses
     exactly H blocks); the list's length is always kept in sync with N (changing N or
     adding/removing a row resizes it, minimum 2 colors); sensible default palette (8 colors,
     height 4 → 10 slots).
   - pour rule toggle: "Classic (pour as much as fits)" vs "Strict (whole color group must fit)".
2. **Generate panel**: difficulty (Easy/Medium/Hard/Expert), optional seed, "Generate" button.
   Show clear errors from the engine.
3. **Puzzle view**: draw slots as vertical tubes with blocks (bottom at bottom), numbered 1..N,
   color names available (title/tooltip + a small legend) for building it physically. Also a
   "setup list" text: "Slot 1 (bottom→top): Red, Blue, Blue, Green".
4. **Play mode**: click a source slot then a destination to pour (using the chosen rules); undo,
   reset, move counter, win message.
5. **Solution viewer**: hidden by default ("Show solution"); step through with Prev/Next, shows
   "Step k/n: Pour Slot A → Slot B (2× Red)", highlights the from/to slots; and a full text list.
   Also a "Hint" button that solves from the CURRENT play state and highlights the next move.
6. Share/reproduce: puzzle encoded in URL hash (encodePuzzle); loading a hash restores it.
   Print-friendly CSS for the puzzle + setup list.
7. Long-running generation must not freeze the page forever: use the time budget, show a
   "Generating…" state (setTimeout yield before calling generatePuzzle is fine).
8. Responsive (phone width), light/dark via prefers-color-scheme.
