#!/usr/bin/env node
'use strict';

// Zero-dependency browser end-to-end test for Color Pour.
// Launches headless Chrome, connects over the Chrome DevTools Protocol (CDP)
// using Node's built-in global WebSocket/fetch, and drives the real UI
// (index.html + src/engine.js + src/app.js) by clicking actual DOM elements
// via Runtime.evaluate. No npm dependencies.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INDEX_URL = pathToFileURL(path.join(REPO_ROOT, 'index.html')).href;
const SCRATCH_DIR = '/private/tmp/claude-501/-Volumes-Ben-s-MacMini-External-Drive-code-color-pour/fe4ede22-a88a-4949-8c89-9126be08c527/scratchpad';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------
// Minimal CDP client over the built-in WebSocket.
// ---------------------------------------------------------------------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this._id = 0;
    this._pending = new Map();
    this._listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id !== undefined && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error('CDP error: ' + msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        const cbs = this._listeners.get(msg.method);
        if (cbs) cbs.slice().forEach((cb) => cb(msg.params));
      }
    });
  }

  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this._id;
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }

  on(method, cb) {
    if (!this._listeners.has(method)) this._listeners.set(method, []);
    this._listeners.get(method).push(cb);
  }

  off(method, cb) {
    const cbs = this._listeners.get(method);
    if (!cbs) return;
    const idx = cbs.indexOf(cb);
    if (idx >= 0) cbs.splice(idx, 1);
  }

  waitForEvent(method, timeoutMs) {
    timeoutMs = timeoutMs || 15000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(method, cb);
        reject(new Error('Timed out waiting for ' + method));
      }, timeoutMs);
      const cb = (params) => {
        clearTimeout(timer);
        this.off(method, cb);
        resolve(params);
      };
      this.on(method, cb);
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error('Page evaluate error: ' + desc);
    }
    return r.result.value;
  }
}

async function waitFor(cdp, exprBool, timeoutMs, intervalMs) {
  timeoutMs = timeoutMs || 6000;
  intervalMs = intervalMs || 100;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await cdp.evaluate(exprBool);
    if (v) return true;
    await sleep(intervalMs);
  }
  return false;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('SKIP: no Chrome/Chromium binary found (set CHROME_PATH to override). Skipping browser e2e test.');
    process.exitCode = 0;
    return;
  }

  fs.mkdirSync(SCRATCH_DIR, { recursive: true });

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'color-pour-e2e-'));
  const portFile = path.join(userDataDir, 'DevToolsActivePort');

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=0',
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1300,1800',
    'about:blank'
  ];

  console.log('Launching: ' + chromePath);
  const chrome = spawn(chromePath, args, { stdio: 'ignore' });
  let chromeExited = false;
  chrome.on('exit', () => { chromeExited = true; });

  const errors = [];
  const consoleErrors = [];
  const exceptions = [];
  let cdp = null;
  const shots = [];

  try {
    // Wait for the DevToolsActivePort file.
    const start = Date.now();
    while (!fs.existsSync(portFile)) {
      if (chromeExited) throw new Error('Chrome exited before writing DevToolsActivePort');
      if (Date.now() - start > 10000) throw new Error('Timed out waiting for DevToolsActivePort');
      await sleep(50);
    }
    // The file can be written before fully flushed; retry parse briefly.
    let port = null;
    for (let i = 0; i < 20; i++) {
      const content = fs.readFileSync(portFile, 'utf8').trim();
      const lines = content.split('\n');
      if (lines[0] && /^\d+$/.test(lines[0])) { port = parseInt(lines[0], 10); break; }
      await sleep(50);
    }
    if (!port) throw new Error('Could not parse DevToolsActivePort');

    const listResp = await fetch('http://127.0.0.1:' + port + '/json/list');
    const targets = await listResp.json();
    const pageTarget = targets.find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('No page target found');

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', (e) => reject(new Error('WebSocket error: ' + e.message)), { once: true });
    });
    cdp = new CDP(ws);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    cdp.on('Log.entryAdded', (p) => {
      if (p.entry && p.entry.level === 'error') consoleErrors.push(p.entry.text);
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        consoleErrors.push(p.args.map((a) => a.value !== undefined ? a.value : (a.description || '')).join(' '));
      }
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      exceptions.push(desc);
    });

    // Chrome treats navigating to the same document with only the URL fragment
    // changed (or removed) as a same-document navigation, which never fires
    // Page.loadEventFired. To reliably simulate "open this link"/"reload the
    // page" (including hash changes), always bounce through about:blank first
    // so every navigate() is a genuine full document load.
    async function navigate(url) {
      let loaded = cdp.waitForEvent('Page.loadEventFired', 15000);
      await cdp.send('Page.navigate', { url: 'about:blank' });
      await loaded;
      loaded = cdp.waitForEvent('Page.loadEventFired', 15000);
      await cdp.send('Page.navigate', { url: url });
      await loaded;
      await sleep(150); // let app.js init() + DOMContentLoaded settle
    }

    // Sets difficulty, clicks Generate, and waits for a genuinely NEW puzzle
    // (by seed) or an error to appear. Just checking "bottles-container has
    // children" is not enough: that's also true of the previous puzzle still
    // on screen while the new (async, up-to-2s) generation is in flight.
    async function generateAndWait(difficulty, timeoutMs) {
      timeoutMs = timeoutMs || 8000;
      const prevSeed = await cdp.evaluate(
        "(function(){var s=window.ColorPourApp.getState().puzzle; return s ? String(s.seed) : null;})()"
      );
      await cdp.evaluate(
        "(function(){var s=document.getElementById('difficulty'); s.value=" + JSON.stringify(difficulty) +
        "; s.dispatchEvent(new Event('change',{bubbles:true})); return true;})()"
      );
      await cdp.evaluate("document.getElementById('generate-btn').click(); true");
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const errVisible = await cdp.evaluate("!document.getElementById('error-box').hidden");
        if (errVisible) return { error: await cdp.evaluate("document.getElementById('error-box').textContent") };
        const seed = await cdp.evaluate(
          "(function(){var s=window.ColorPourApp.getState().puzzle; return s ? String(s.seed) : null;})()"
        );
        const panelVisible = await cdp.evaluate("!document.getElementById('puzzle-panel').hidden");
        if (panelVisible && seed !== null && seed !== prevSeed) {
          return { state: await cdp.evaluate('window.ColorPourApp.getState()') };
        }
        await sleep(100);
      }
      throw new Error('Timed out waiting for a new puzzle (' + difficulty + ')');
    }

    // Verifies blocks rest at the BOTTOM of each tube (gravity), not float at
    // the top with empty space below. For every bottle that is partially
    // filled (0 < len < capacity):
    //   1. the bottom-most rendered .block's bottom edge must sit flush
    //      against the tube's own bottom edge (small padding tolerance);
    //   2. reading blocks top-to-bottom on screen (by Y position) must equal
    //      the state array reversed (state[0] is the bottom block, so the
    //      top-to-bottom visual reading is the array reversed).
    async function assertBottlesRestOnBottom(state, rules, colors, containerSelector) {
      containerSelector = containerSelector || '#bottles-container';
      const labels = await cdp.evaluate('window.ColorPourApp.computeColorLabels(' + JSON.stringify(colors) + ')');
      const results = await cdp.evaluate(
        "(function(){" +
        "var bottles = document.querySelectorAll(" + JSON.stringify(containerSelector) + " + ' .bottle');" +
        "var out = [];" +
        "bottles.forEach(function(b, idx){" +
        "  var blocks = b.querySelectorAll('.block');" +
        "  if (!blocks.length) return;" +
        "  var br = b.getBoundingClientRect();" +
        "  var items = Array.prototype.map.call(blocks, function(el){ var r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, letter: el.textContent }; });" +
        "  items.sort(function(a,b2){ return a.top - b2.top; });" + // top-to-bottom visual order
        "  var bottomMost = items[items.length - 1];" +
        "  out.push({ idx: idx, tubeBottom: br.bottom, blockBottom: bottomMost.bottom, lettersTopToBottom: items.map(function(i){ return i.letter; }) });" +
        "});" +
        "return out;})()"
      );
      let checked = 0;
      results.forEach((r) => {
        const bottle = state[r.idx];
        if (bottle.length === 0 || bottle.length >= rules.capacity) return; // only meaningful when there's empty space to float into
        checked++;
        assert.ok(r.tubeBottom > 0, 'slot ' + (r.idx + 1) + ': tube is actually rendered (non-zero layout box)');
        assert.ok(
          Math.abs(r.tubeBottom - r.blockBottom) < 6,
          'slot ' + (r.idx + 1) + ': bottom block should be flush with the tube bottom (tube bottom=' +
          r.tubeBottom.toFixed(1) + ', block bottom=' + r.blockBottom.toFixed(1) + ') — blocks must rest on the bottom, not float at the top'
        );
        const expectedTopToBottom = bottle.slice().reverse().map((ci) => labels[ci] || '?');
        assert.deepStrictEqual(
          r.lettersTopToBottom, expectedTopToBottom,
          'slot ' + (r.idx + 1) + ': visual top-to-bottom block order should be the reverse of state[idx] (top color first)'
        );
      });
      return checked;
    }

    async function screenshot(name) {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(SCRATCH_DIR, name);
      fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
      shots.push(p);
      console.log('Screenshot: ' + p);
    }

    // ---- 1. Load page, check for console errors / exceptions ----
    console.log('\n[1] Loading page and checking for console errors...');
    await navigate(INDEX_URL);
    await sleep(200);
    assert.strictEqual(exceptions.length, 0, 'No JS exceptions on load, got: ' + exceptions.join(' | '));
    assert.strictEqual(consoleErrors.length, 0, 'No console.error on load, got: ' + consoleErrors.join(' | '));
    const hasApp = await cdp.evaluate('typeof window.ColorPour === "object" && typeof window.ColorPourApp === "object"');
    assert.ok(hasApp, 'ColorPour engine and ColorPourApp debug hook are present');
    console.log('  OK: no console errors/exceptions, engine + app loaded.');

    // Colorblind-aid labels (block letters + legend) must be unique per
    // puzzle, even when two color names share a first letter (Purple/Pink).
    const defaultPalette = ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange', 'Pink', 'Teal'];
    const defaultLabels = await cdp.evaluate(
      'window.ColorPourApp.computeColorLabels(' + JSON.stringify(defaultPalette.map((name) => ({ name: name }))) + ')'
    );
    assert.strictEqual(defaultLabels.length, defaultPalette.length, 'computeColorLabels returns one label per color');
    assert.strictEqual(new Set(defaultLabels).size, defaultLabels.length,
      'default-palette labels must all be unique, got: ' + JSON.stringify(defaultLabels));
    const purpleIdx = defaultPalette.indexOf('Purple');
    const pinkIdx = defaultPalette.indexOf('Pink');
    assert.notStrictEqual(defaultLabels[purpleIdx], defaultLabels[pinkIdx],
      'Purple and Pink (both start with "P") must get distinct labels, got: ' + JSON.stringify(defaultLabels));
    console.log('  OK: default-palette color labels are unique: ' + JSON.stringify(defaultLabels));

    // ---- 2. Generate for each difficulty ----
    console.log('\n[2] Generating a puzzle for each difficulty...');
    let mediumPuzzle = null;
    for (const difficulty of ['easy', 'medium', 'hard', 'expert']) {
      const result = await generateAndWait(difficulty);
      assert.ok(!result.error, difficulty + ': no error shown for default kit + this difficulty, got: ' + result.error);

      const state = result.state;
      const puzzle = state.puzzle;
      assert.ok(puzzle && Array.isArray(puzzle.state), difficulty + ': puzzle state present');

      const slotCount = await cdp.evaluate("document.querySelectorAll('#bottles-container .bottle').length");
      assert.strictEqual(slotCount, puzzle.state.length, difficulty + ': rendered slot count matches puzzle.state.length');

      const blockCount = await cdp.evaluate("document.querySelectorAll('#bottles-container .block').length");
      const expectedBlocks = puzzle.state.reduce((s, b) => s + b.length, 0);
      assert.strictEqual(blockCount, expectedBlocks, difficulty + ': rendered block count matches total blocks in state');

      const setupText = await cdp.evaluate("document.getElementById('setup-list-text').textContent");
      assert.ok(/Slot 1/.test(setupText), difficulty + ': setup list text mentions Slot 1');

      // Physical kit setup rules: slots = colors + 2, exactly 2 start empty,
      // every other slot starts completely full at height H.
      assert.strictEqual(puzzle.state.length, puzzle.colors.length + 2,
        difficulty + ': slots must equal colors + 2');
      const emptySlots = puzzle.state.filter((b) => b.length === 0).length;
      assert.strictEqual(emptySlots, 2, difficulty + ': exactly 2 slots must start empty');
      puzzle.state.forEach((b, idx) => {
        if (b.length === 0) return;
        assert.strictEqual(b.length, puzzle.rules.capacity,
          difficulty + ': slot ' + idx + ' must start completely full or empty');
      });

      const gravityChecked = await assertBottlesRestOnBottom(puzzle.state, puzzle.rules, puzzle.colors);

      console.log('  ' + difficulty + ': ' + slotCount + ' slots, ' + blockCount + ' blocks, ' + puzzle.solution.length +
        ' move solution, gravity OK on ' + gravityChecked + ' partial tube(s).');

      if (difficulty === 'medium') mediumPuzzle = puzzle;
    }
    assert.ok(mediumPuzzle, 'captured a medium puzzle to play through');

    await screenshot('puzzle-generated.png');

    // Re-generate medium fresh (previous loop already left an expert-ish generated
    // state before this) so we have a clean puzzle to play.
    let result = await generateAndWait('medium');
    assert.ok(!result.error, 'medium (replay): no error, got: ' + result.error);
    let puzzle = result.state.puzzle;

    // ---- 6. Share via URL hash (do this on the freshly generated, unplayed puzzle) ----
    console.log('\n[6] Testing share via URL hash + reload...');
    const hash = await cdp.evaluate('location.hash');
    assert.ok(/^#p=/.test(hash), 'location.hash was set to #p=<encoded puzzle>');
    await navigate(INDEX_URL + hash);
    const reloadedState = await cdp.evaluate('window.ColorPourApp.getState()');
    assert.deepStrictEqual(reloadedState.puzzle.state, puzzle.state, 'reloading the hash restores the same puzzle state');
    assert.deepStrictEqual(reloadedState.puzzle.colors, puzzle.colors, 'reloading the hash restores the same colors');
    console.log('  OK: reload from hash restores the same puzzle.');
    // Keep working with the reloaded puzzle/state from here on.
    puzzle = reloadedState.puzzle;

    // ---- 3. Play the full solution, then undo/reset ----
    console.log('\n[3] Playing the full solution via clicks...');
    for (const mv of puzzle.solution) {
      await cdp.evaluate(
        "document.querySelectorAll('#bottles-container .bottle')[" + mv.from + "].click(); true"
      );
      await cdp.evaluate(
        "document.querySelectorAll('#bottles-container .bottle')[" + mv.to + "].click(); true"
      );
    }
    const solved = await waitFor(cdp, "!document.getElementById('win-message').hidden", 3000);
    assert.ok(solved, 'win message appears after replaying the full solution');
    console.log('  OK: solved via ' + puzzle.solution.length + ' clicks, win message shown.');

    const movesBeforeUndo = await cdp.evaluate("document.getElementById('move-counter').textContent");
    assert.strictEqual(parseInt(movesBeforeUndo, 10), puzzle.solution.length, 'move counter matches solution length');

    await cdp.evaluate("document.getElementById('undo-btn').click(); true");
    const winHiddenAfterUndo = await cdp.evaluate("document.getElementById('win-message').hidden");
    assert.ok(winHiddenAfterUndo, 'undo hides the win message');
    const movesAfterUndo = await cdp.evaluate("document.getElementById('move-counter').textContent");
    assert.strictEqual(parseInt(movesAfterUndo, 10), puzzle.solution.length - 1, 'undo decrements the move counter');
    console.log('  OK: undo works.');

    await cdp.evaluate("document.getElementById('reset-btn').click(); true");
    const movesAfterReset = await cdp.evaluate("document.getElementById('move-counter').textContent");
    assert.strictEqual(parseInt(movesAfterReset, 10), 0, 'reset zeroes the move counter');
    const stateAfterReset = await cdp.evaluate('window.ColorPourApp.getState().playState');
    assert.deepStrictEqual(stateAfterReset, puzzle.state, 'reset restores the original puzzle state');
    console.log('  OK: reset works.');

    // ---- 4. Hint ----
    console.log('\n[4] Testing hint...');
    await cdp.evaluate("document.getElementById('hint-btn').click(); true");
    const hintShown = await waitFor(cdp, "document.getElementById('hint-message').textContent.indexOf('Hint:') === 0", 3000);
    assert.ok(hintShown, 'hint message shows a "Hint: ..." move suggestion');
    const highlightCount = await cdp.evaluate("document.querySelectorAll('#bottles-container .bottle.highlight-from, #bottles-container .bottle.highlight-to').length");
    assert.ok(highlightCount >= 1, 'hint highlights at least one slot');
    console.log('  OK: hint highlighted ' + highlightCount + ' slot(s).');

    // ---- 5. Solution viewer Prev/Next ----
    console.log('\n[5] Testing solution viewer stepping...');
    await cdp.evaluate("document.getElementById('solution-details').open = true; true");
    const step0 = await cdp.evaluate("document.getElementById('solution-step-text').textContent");
    await cdp.evaluate("document.getElementById('sol-next-btn').click(); true");
    const step1 = await cdp.evaluate("document.getElementById('solution-step-text').textContent");
    assert.notStrictEqual(step0, step1, 'Next changes the step text');
    assert.ok(/^Step 2\//.test(step1), 'step text advances to Step 2/N: got "' + step1 + '"');
    await cdp.evaluate("document.getElementById('sol-prev-btn').click(); true");
    const step0again = await cdp.evaluate("document.getElementById('solution-step-text').textContent");
    assert.strictEqual(step0again, step0, 'Prev returns to the original step text');
    console.log('  OK: solution viewer Next/Prev works.');

    // Also verify gravity in the solution viewer's own bottle rendering
    // (separate DOM tree from the main puzzle view, same buildBottleElement code path).
    await cdp.evaluate("document.getElementById('sol-next-btn').click(); true"); // step onto a step with a partial pour
    const solStep = await cdp.evaluate(
      "(function(){" +
      "var st = window.ColorPourApp.getState();" +
      "var states = ColorPour.applyMoves(st.puzzle.state, st.puzzle.solution, st.puzzle.rules);" +
      "return { state: states[st.solutionIndex], rules: st.puzzle.rules, colors: st.puzzle.colors };" +
      "})()"
    );
    const solGravityChecked = await assertBottlesRestOnBottom(solStep.state, solStep.rules, solStep.colors, '#solution-bottles');
    console.log('  OK: solution viewer gravity checked on ' + solGravityChecked + ' partial tube(s).');
    await cdp.evaluate("document.getElementById('sol-prev-btn').click(); true"); // back to step0 for the screenshot below

    await cdp.evaluate("document.getElementById('solution-details').scrollIntoView({block:'start'}); true");
    await sleep(100);
    await screenshot('solution-viewer.png');

    // ---- 7. Impossible/invalid config shows an error, not a crash ----
    // Slot count and empty-slot count are no longer user-configurable (both
    // are derived: slots = colors + 2, always exactly 2 empty), and the UI
    // itself clamps slot height to >= 2, so those old "impossible config"
    // paths are no longer reachable through the form. An empty color name
    // IS still reachable through the form, and the engine rejects it.
    console.log('\n[7] Testing an invalid config (blank color name)...');
    const excBefore = exceptions.length;
    await cdp.evaluate(
      "(function(){" +
      "var nameInput=document.querySelector('#inventory-list .inventory-row input[type=text]');" +
      "nameInput.value=''; nameInput.dispatchEvent(new Event('input',{bubbles:true}));" +
      "return true;})()"
    );
    await cdp.evaluate("document.getElementById('generate-btn').click(); true");
    await sleep(300);
    const errorShown = await waitFor(cdp, "!document.getElementById('error-box').hidden", 3000);
    assert.ok(errorShown, 'an error message is shown for an invalid config');
    const errorText = await cdp.evaluate("document.getElementById('error-box').textContent");
    assert.ok(errorText && errorText.length > 0, 'error box has text: ' + errorText);
    assert.strictEqual(exceptions.length, excBefore, 'no uncaught JS exception was thrown for the invalid config');
    console.log('  OK: invalid config produced a clean error ("' + errorText + '"), no crash.');

    // restore a sane color name for anything after this
    await cdp.evaluate(
      "(function(){" +
      "var nameInput=document.querySelector('#inventory-list .inventory-row input[type=text]');" +
      "nameInput.value='Red'; nameInput.dispatchEvent(new Event('input',{bubbles:true}));" +
      "return true;})()"
    );

    // ---- 8. localStorage persistence of kit setup across reload ----
    console.log('\n[8] Testing localStorage persistence of kit setup...');
    await cdp.evaluate(
      "(function(){" +
      "var n=document.getElementById('input-colors'); n.value='4'; n.dispatchEvent(new Event('change',{bubbles:true}));" +
      "var c=document.getElementById('input-capacity'); c.value='3'; c.dispatchEvent(new Event('input',{bubbles:true}));" +
      "document.getElementById('save-setup-btn').click();" +
      "return true;})()"
    );
    await navigate(INDEX_URL); // fresh load, no hash
    const colorsAfterReload = await cdp.evaluate("document.getElementById('input-colors').value");
    const capacityAfterReload = await cdp.evaluate("document.getElementById('input-capacity').value");
    assert.strictEqual(colorsAfterReload, '4', 'color count persisted across reload via localStorage');
    assert.strictEqual(capacityAfterReload, '3', 'slot height persisted across reload via localStorage');
    console.log('  OK: kit setup persisted across reload.');

    // ---- 8b. Reset button clears saved setup ----
    console.log('\n[8b] Testing reset button...');
    // Verify saved state: still 4 colors, 3 capacity
    let colorsBeforeReset = await cdp.evaluate("document.getElementById('input-colors').value");
    let capacityBeforeReset = await cdp.evaluate("document.getElementById('input-capacity').value");
    assert.strictEqual(colorsBeforeReset, '4', 'colors are 4 before reset');
    assert.strictEqual(capacityBeforeReset, '3', 'capacity is 3 before reset');
    // Override confirm to always return true (accept reset)
    await cdp.evaluate("window.confirm = function(msg) { return true; }");
    // Click reset button
    await cdp.evaluate("document.getElementById('reset-setup-btn').click(); true");
    // Verify defaults are restored
    const colorsAfterReset = await cdp.evaluate("document.getElementById('input-colors').value");
    const capacityAfterReset = await cdp.evaluate("document.getElementById('input-capacity').value");
    assert.strictEqual(colorsAfterReset, '9', 'color count reset to default (9)');
    assert.strictEqual(capacityAfterReset, '5', 'slot height reset to default (5)');
    // Reload and verify localStorage was cleared
    await navigate(INDEX_URL);
    const colorsAfterReloadPostReset = await cdp.evaluate("document.getElementById('input-colors').value");
    const capacityAfterReloadPostReset = await cdp.evaluate("document.getElementById('input-capacity').value");
    assert.strictEqual(colorsAfterReloadPostReset, '9', 'color count is still default (9) after reload (localStorage cleared)');
    assert.strictEqual(capacityAfterReloadPostReset, '5', 'slot height is still default (5) after reload (localStorage cleared)');
    console.log('  OK: reset button clears saved setup and restores defaults.');

    // ---- 8c. Printable set: N puzzles, 6 per legal page, answer key ----
    console.log('\n[8c] Testing printable puzzle set...');
    await cdp.evaluate(
      "(function(){" +
      "document.getElementById('difficulty').value='easy';" +
      "document.getElementById('seed-input').value='print-set';" +
      "document.getElementById('batch-count').value='8';" +
      "document.getElementById('batch-answers').checked=true;" +
      "document.getElementById('batch-generate-btn').click();" +
      "return true;})()"
    );
    const setReady = await waitFor(cdp, "!document.getElementById('batch-panel').hidden", 30000, 200);
    assert.ok(setReady, 'printable set panel appears after generating');
    const setInfo = await cdp.evaluate(
      "(function(){" +
      "var pages = document.querySelectorAll('#print-sheet .print-page');" +
      "return {" +
      "  pages: pages.length," +
      "  perPage: Array.prototype.map.call(pages, function(p){ return p.querySelectorAll('.print-card').length; })," +
      "  bottlesPerCard: document.querySelector('.print-card').querySelectorAll('.bottle').length," +
      "  staticTubes: document.querySelectorAll('#print-sheet button.bottle').length," +
      "  answers: document.querySelectorAll('.print-answers-list li').length," +
      "  error: !document.getElementById('error-box').hidden" +
      "};})()"
    );
    assert.strictEqual(setInfo.error, false, 'no error while generating a set');
    assert.deepStrictEqual(setInfo.perPage, [6, 2], '8 puzzles lay out as 6 on page 1 and 2 on page 2');
    assert.strictEqual(setInfo.bottlesPerCard, 11, 'each card shows all N + 2 = 11 slots');
    assert.strictEqual(setInfo.staticTubes, 0, 'printed tubes are static (not buttons)');
    assert.strictEqual(setInfo.answers, 8, 'answer key lists one entry per puzzle');

    // Same seed => same set (reproducible for re-printing).
    const firstSetText = await cdp.evaluate("document.getElementById('print-sheet').textContent");
    await cdp.evaluate("document.getElementById('batch-panel').hidden=true; document.getElementById('batch-generate-btn').click(); true");
    assert.ok(await waitFor(cdp, "!document.getElementById('batch-panel').hidden", 30000, 200), 'set regenerates');
    const secondSetText = await cdp.evaluate("document.getElementById('print-sheet').textContent");
    assert.strictEqual(secondSetText, firstSetText, 'a typed seed reproduces the same set');

    // Print to PDF the way the Print set button does (legal @page + body class)
    // and check it's 3 pages: 2 puzzle pages + 1 answer page.
    await cdp.evaluate("window.print = function(){}; document.getElementById('batch-print-btn').click(); true");
    const pdf = await cdp.send('Page.printToPDF', { preferCSSPageSize: true, printBackground: true });
    const pdfBuf = Buffer.from(pdf.data, 'base64');
    fs.writeFileSync(path.join(SCRATCH_DIR, 'print-set.pdf'), pdfBuf);
    const pdfPages = (pdfBuf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    assert.strictEqual(pdfPages, 3, 'printed set is 3 legal pages (got ' + pdfPages + ')');
    const mediaBox = pdfBuf.toString('latin1').match(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/);
    assert.ok(mediaBox && Math.round(+mediaBox[1]) === 612 && Math.round(+mediaBox[2]) === 1008,
      'PDF page is legal size 612x1008pt (got ' + (mediaBox && mediaBox.slice(1).join('x')) + ')');
    // Chrome fires afterprint after each printToPDF, so re-arm the set print.
    for (const range of ['1', '3']) {
      await cdp.evaluate("document.getElementById('batch-print-btn').click(); true");
      const part = await cdp.send('Page.printToPDF', { preferCSSPageSize: true, printBackground: true, pageRanges: range });
      fs.writeFileSync(path.join(SCRATCH_DIR, 'print-set-page' + range + '.pdf'), Buffer.from(part.data, 'base64'));
    }
    await cdp.evaluate("window.dispatchEvent(new Event('afterprint')); true");
    const cleaned = await cdp.evaluate("!document.body.classList.contains('printing-set') && !document.getElementById('print-set-page-style')");
    assert.ok(cleaned, 'afterprint removes the set-printing class and legal @page rule');
    await cdp.evaluate("document.getElementById('seed-input').value=''; document.getElementById('difficulty').value='medium'; true");
    console.log('  OK: printable set (6 per legal page + answer key) renders and prints to 3 pages.');

    // ---- 9. Mobile viewport + dark mode screenshots ----
    console.log('\n[9] Capturing mobile viewport and dark mode screenshots...');
    // Put a puzzle back on screen for a meaningful screenshot.
    await generateAndWait('medium');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true
    });
    await sleep(150);
    await screenshot('mobile-390px.png');
    await cdp.evaluate("document.getElementById('puzzle-panel').scrollIntoView({block:'start'}); true");
    await sleep(100);
    await screenshot('mobile-390px-puzzle.png');
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await sleep(150);
    await screenshot('dark-mode.png');
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    console.log('\nAll e2e checks passed.');
    console.log('Screenshots written to: ' + SCRATCH_DIR);
    shots.forEach((s) => console.log('  - ' + s));
  } catch (e) {
    errors.push(e);
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (e) { /* ignore */ }
    try { chrome.kill('SIGKILL'); } catch (e) { /* ignore */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  if (errors.length) {
    console.error('\nFAILED:');
    errors.forEach((e) => console.error(e && e.stack ? e.stack : e));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
