(function () {
  'use strict';

  var STORAGE_KEY = 'colorpour.setup.v2';

  // Physical kit rule: the user only picks the number of distinct colors (N,
  // the length of this list) and the slot height (H, setup.capacity). Slots
  // are always N + 2 (derived); there is no per-color block count to set —
  // every color always appears exactly H times.
  var DEFAULT_COLORS = [
    { name: 'Red', hex: '#e53935' },
    { name: 'Blue', hex: '#1e88e5' },
    { name: 'White', hex: '#f5f5f5' },
    { name: 'Orange', hex: '#fb8c00' },
    { name: 'Green', hex: '#43a047' },
    { name: 'Yellow', hex: '#fdd835' },
    { name: 'Gray', hex: '#757575' },
    { name: 'Pink', hex: '#ec407a' },
    { name: 'Purple', hex: '#8e24aa' }
  ];
  // Colors appended beyond the defaults continue from index 9, so the first
  // nine entries mirror DEFAULT_COLORS to avoid duplicate hues.
  var COLOR_PALETTE = ['#e53935', '#1e88e5', '#f5f5f5', '#fb8c00', '#43a047', '#fdd835', '#757575', '#ec407a', '#8e24aa', '#00897b', '#6d4c41'];

  // ---- app state ----
  function defaultSetup() {
    return {
      capacity: 5,
      pourMode: 'classic',
      colors: cloneColors(DEFAULT_COLORS)
    };
  }

  var setup = defaultSetup();

  var currentPuzzle = null;
  var playState = null;
  var pastStates = null; // stack of states, index 0 = initial
  var selectedSlot = null;
  var hintHighlight = null; // {from,to}
  var showEmptySlots = false; // puzzle view hides the trailing empty slots unless toggled on

  var solutionStates = null;
  var solutionIndex = 0;

  // ---- helpers ----
  function cloneColors(arr) { return arr.map(function (c) { return { name: c.name, hex: c.hex }; }); }
  function cloneState(state) { return state.map(function (b) { return b.slice(); }); }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function showError(msg) {
    var box = $('error-box');
    box.textContent = msg;
    box.hidden = false;
  }
  function clearError() {
    var box = $('error-box');
    box.hidden = true;
    box.textContent = '';
  }

  // ---- persistence ----
  function saveSetup() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(setup));
    } catch (e) { /* ignore */ }
  }
  function loadSetup() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && parsed.colors && parsed.colors.length) {
        setup.capacity = parsed.capacity || setup.capacity;
        setup.pourMode = parsed.pourMode || setup.pourMode;
        setup.colors = cloneColors(parsed.colors);
      }
    } catch (e) { /* ignore */ }
  }

  // ---- setup panel rendering ----
  // Number of colors (N) and slot height (H) are the ONLY two settings the
  // user picks; the color list's length is always kept in sync with N (a
  // color has just a name + swatch — no per-color block count, since every
  // color always uses exactly H blocks).
  function makeInventoryRow(color, onRemove) {
    var row = el('div', 'inventory-row');

    var colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = color.hex;
    colorInput.addEventListener('input', function () { color.hex = colorInput.value; });

    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = color.name;
    nameInput.placeholder = 'Color name';
    nameInput.addEventListener('input', function () { color.name = nameInput.value; });

    var removeBtn = el('button', 'remove-btn', '×');
    removeBtn.type = 'button';
    removeBtn.setAttribute('aria-label', 'Remove color');
    removeBtn.addEventListener('click', onRemove);

    row.appendChild(colorInput);
    row.appendChild(nameInput);
    row.appendChild(removeBtn);
    return row;
  }

  function renderInventoryList() {
    var container = $('inventory-list');
    container.innerHTML = '';
    setup.colors.forEach(function (color, i) {
      container.appendChild(makeInventoryRow(color, function () {
        if (setup.colors.length <= 2) return; // need at least 2 colors
        setup.colors.splice(i, 1);
        renderInventoryList();
        updateSlotsReadout();
      }));
    });
    $('input-colors').value = setup.colors.length;
    updateSlotsReadout();
  }

  function updateSlotsReadout() {
    var readout = $('slots-readout');
    if (readout) {
      readout.textContent = 'Uses ' + setup.colors.length + ' + 2 = ' +
        (setup.colors.length + 2) + ' slots (colors + 2 empty), derived automatically.';
    }
  }

  // Grows or shrinks setup.colors to exactly `n` entries (min 2), appending
  // default palette colors or truncating from the end, then re-renders.
  function resizeColorsTo(n) {
    n = Math.max(2, Math.min(30, Math.floor(n) || 2));
    while (setup.colors.length < n) {
      var i = setup.colors.length;
      setup.colors.push({ name: 'Color ' + (i + 1), hex: COLOR_PALETTE[i % COLOR_PALETTE.length] });
    }
    if (setup.colors.length > n) setup.colors.length = n;
    renderInventoryList();
  }

  function addColorRow() {
    resizeColorsTo(setup.colors.length + 1);
  }

  function readSetupBasicsFromForm() {
    setup.capacity = Math.max(2, parseInt($('input-capacity').value, 10) || 4);
    setup.pourMode = $('pour-mode').value;
  }

  function applySetupToForm() {
    $('input-colors').value = setup.colors.length;
    $('input-capacity').value = setup.capacity;
    $('pour-mode').value = setup.pourMode;
    renderInventoryList();
  }

  function buildGenerationConfig() {
    readSetupBasicsFromForm();
    var difficulty = $('difficulty').value;
    var seedRaw = $('seed-input').value.trim();
    if (setup.colors.length < 2) {
      throw new Error('Add at least 2 colors (see Setup).');
    }
    var config = {
      capacity: setup.capacity,
      colors: setup.colors.map(function (c) { return { name: c.name, hex: c.hex }; }),
      pourMode: setup.pourMode,
      difficulty: difficulty
    };
    if (seedRaw) config.seed = seedRaw;
    return config;
  }

  // ---- puzzle rendering ----

  // Computes a short, colorblind-friendly label per color that is UNIQUE
  // within the given list (e.g. Purple/Pink would both be "P" as a bare
  // first letter, so one or both grow to "Pu"/"Pi"). Pure function of
  // `colors` (array of {name}); exposed on window.ColorPourApp for testing.
  function computeColorLabels(colors) {
    var names = colors.map(function (c) {
      var n = (c && c.name ? String(c.name) : '').trim();
      return n || '?';
    });
    var lengths = names.map(function () { return 1; });

    function labelAt(i) {
      var n = names[i];
      var len = Math.min(lengths[i], n.length || 1);
      var prefix = n.length ? n.slice(0, len) : '?';
      return prefix.charAt(0).toUpperCase() + prefix.slice(1);
    }

    // Grow the prefix length of any colliding names until they're unique or
    // we've used the whole name (bounded by the longest name so this always
    // terminates).
    var maxIterations = names.reduce(function (m, n) { return Math.max(m, n.length); }, 1);
    for (var iter = 0; iter < maxIterations; iter++) {
      var groups = {};
      var i;
      for (i = 0; i < names.length; i++) {
        var lbl = labelAt(i);
        (groups[lbl] = groups[lbl] || []).push(i);
      }
      var changed = false;
      Object.keys(groups).forEach(function (lbl) {
        var idxs = groups[lbl];
        if (idxs.length > 1) {
          idxs.forEach(function (i2) {
            if (lengths[i2] < names[i2].length) { lengths[i2]++; changed = true; }
          });
        }
      });
      if (!changed) break;
    }

    var labels = names.map(function (n, i) { return labelAt(i); });

    // Last-resort fallback: identical names (or names that are prefixes of
    // one another, e.g. "Red"/"Red") can still collide even at full length —
    // number them so every label stays unique.
    var seen = {};
    labels.forEach(function (lbl, i) {
      (seen[lbl] = seen[lbl] || []).push(i);
    });
    Object.keys(seen).forEach(function (lbl) {
      var idxs = seen[lbl];
      if (idxs.length > 1) {
        idxs.forEach(function (i, order) { labels[i] = lbl + (order + 1); });
      }
    });

    return labels;
  }

  function buildBottleElement(bottle, idx, colors, labels, capacity, opts) {
    opts = opts || {};
    var wrap = el('div', 'bottle-wrap');
    // Printed cards aren't interactive, so they get a plain <div> tube and a
    // bare slot number that's no wider than the (narrow) tube.
    // On-screen labels read "Slot N", but the word is hidden on narrow screens
    // (see styles.css) so the label is no wider than the tube.
    var label = el('div', 'bottle-label');
    if (!opts.static) label.appendChild(el('span', 'bottle-label-word', 'Slot '));
    label.appendChild(document.createTextNode(String(idx + 1)));

    var btn = document.createElement(opts.static ? 'div' : 'button');
    if (!opts.static) btn.type = 'button';
    btn.className = 'bottle';
    btn.setAttribute('aria-label', 'Slot ' + (idx + 1));
    if (opts.selected === idx) btn.classList.add('selected');
    if (opts.highlightFrom === idx) btn.classList.add('highlight-from');
    if (opts.highlightTo === idx) btn.classList.add('highlight-to');

    // .bottle uses flex-direction: column-reverse, so the FIRST DOM child
    // lands at the bottom (main-start) of the tube. bottle[0] is the bottom
    // block, so real blocks (in array order) must be appended before the
    // empty placeholders, or the empties claim the bottom and blocks float
    // to the top.
    bottle.forEach(function (colorIdx) {
      var c = colors[colorIdx] || { name: '?', hex: '#999' };
      var block = el('div', 'block', labels[colorIdx] || '?');
      block.style.background = c.hex;
      block.title = c.name;
      btn.appendChild(block);
    });
    var emptyCount = capacity - bottle.length;
    for (var e = 0; e < emptyCount; e++) {
      btn.appendChild(el('div', 'block-empty-slot'));
    }

    if (opts.onClick) btn.addEventListener('click', function () { opts.onClick(idx); });

    wrap.appendChild(btn);
    wrap.appendChild(label);
    return wrap;
  }

  function renderBottleGroup(container, state, colors, capacity, opts) {
    container.innerHTML = '';
    var labels = computeColorLabels(colors);
    var visible = opts && opts.visibleCount != null ? opts.visibleCount : state.length;
    state.slice(0, visible).forEach(function (bottle, idx) {
      container.appendChild(buildBottleElement(bottle, idx, colors, labels, capacity, opts));
    });
  }

  // Number of slots to show in the puzzle view: unless the player toggles
  // them on, the trailing slots that start empty (and are still empty) are
  // omitted so the full slots fit on one row on a phone.
  function visibleSlotCount() {
    var n = playState.length;
    if (showEmptySlots) return n;
    while (n > 0 && !playState[n - 1].length && !currentPuzzle.state[n - 1].length) n--;
    return n;
  }

  function updateEmptySlotsButton() {
    var btn = $('empty-slots-btn');
    var hidden = currentPuzzle ? playState.length - visibleSlotCount() : 0;
    btn.textContent = showEmptySlots ? 'Hide empty slots' : 'Show empty slots';
    btn.hidden = !showEmptySlots && hidden === 0;
  }

  function onToggleEmptySlots() {
    showEmptySlots = !showEmptySlots;
    renderPlayBottles();
  }

  function renderLegend(colors, legend) {
    legend = legend || $('legend');
    legend.innerHTML = '';
    var labels = computeColorLabels(colors);
    colors.forEach(function (c, i) {
      var item = el('div', 'legend-item');
      var swatch = el('span', 'legend-swatch', labels[i]);
      swatch.style.background = c.hex;
      item.appendChild(swatch);
      item.appendChild(el('span', null, c.name));
      legend.appendChild(item);
    });
  }

  function setupListText(state, colors) {
    var lines = state.map(function (bottle, idx) {
      if (!bottle.length) return 'Slot ' + (idx + 1) + ': (empty)';
      var names = bottle.map(function (ci) { return (colors[ci] || { name: '?' }).name; });
      return 'Slot ' + (idx + 1) + ' (bottom→top): ' + names.join(', ');
    });
    return lines.join('\n');
  }

  function moveText(move, colors) {
    var color = (colors[move.color] || { name: '?' }).name;
    return 'Pour Slot ' + (move.from + 1) + ' → Slot ' + (move.to + 1) + ' (' + move.count + '× ' + color + ')';
  }

  // ---- generation flow ----
  function onGenerateClick() {
    clearError();
    var config;
    try {
      config = buildGenerationConfig();
    } catch (e) {
      showError(e.message);
      return;
    }
    $('generating-msg').hidden = false;
    $('generate-btn').disabled = true;
    setTimeout(function () {
      var puzzle;
      try {
        puzzle = ColorPour.generatePuzzle(config, { timeBudgetMs: 2000 });
        if (!puzzle) throw new Error('Could not generate a puzzle with these settings. Try a different number of colors, slot height, or difficulty.');
      } catch (err) {
        $('generating-msg').hidden = true;
        $('generate-btn').disabled = false;
        showError(err.message || String(err));
        return;
      }
      $('generating-msg').hidden = true;
      $('generate-btn').disabled = false;
      loadPuzzle(puzzle);
    }, 30);
  }

  function loadPuzzle(puzzle) {
    currentPuzzle = puzzle;
    playState = cloneState(puzzle.state);
    pastStates = [cloneState(puzzle.state)];
    selectedSlot = null;
    hintHighlight = null;
    $('hint-message').hidden = true;
    $('win-message').hidden = true;

    solutionStates = ColorPour.applyMoves(puzzle.state, puzzle.solution || [], puzzle.rules);
    solutionIndex = 0;

    $('puzzle-panel').hidden = false;
    var scoreLabel = puzzle.score ? (puzzle.score.label + ', ' + puzzle.score.moves + ' moves') : '';
    $('puzzle-meta').textContent = puzzle.difficulty ? '(' + puzzle.difficulty + (scoreLabel ? ' – optimal-ish solution: ' + puzzle.score.moves + ' moves' : '') + ')' : '';

    renderLegend(puzzle.colors);
    $('setup-list-text').textContent = setupListText(puzzle.state, puzzle.colors);
    renderPlayBottles();
    renderSolutionStep();
    updateMoveCounter();

    updateUrlHash();
  }

  function renderPlayBottles() {
    var opts = {
      onClick: onSlotClick,
      selected: selectedSlot,
      highlightFrom: hintHighlight ? hintHighlight.from : null,
      highlightTo: hintHighlight ? hintHighlight.to : null,
      visibleCount: visibleSlotCount()
    };
    renderBottleGroup($('bottles-container'), playState, currentPuzzle.colors, currentPuzzle.rules.capacity, opts);
    updateEmptySlotsButton();
  }

  function updateMoveCounter() {
    $('move-counter').textContent = String(pastStates.length - 1);
  }

  // ---- play mode ----
  function onSlotClick(idx) {
    hintHighlight = null;
    $('hint-message').hidden = true;
    if (selectedSlot === null) {
      if (!playState[idx].length) return;
      selectedSlot = idx;
      renderPlayBottles();
      return;
    }
    if (selectedSlot === idx) {
      selectedSlot = null;
      renderPlayBottles();
      return;
    }
    var from = selectedSlot;
    var to = idx;
    var result = ColorPour.pour(playState, from, to, currentPuzzle.rules);
    selectedSlot = null;
    if (!result) {
      showError('That pour isn’t allowed with the current rules.');
      renderPlayBottles();
      return;
    }
    clearError();
    playState = result.state;
    pastStates.push(cloneState(playState));
    updateMoveCounter();
    renderPlayBottles();
    if (ColorPour.isSolved(playState, currentPuzzle.rules)) {
      $('win-message').hidden = false;
    }
  }

  function onUndo() {
    if (pastStates.length <= 1) return;
    pastStates.pop();
    playState = cloneState(pastStates[pastStates.length - 1]);
    selectedSlot = null;
    hintHighlight = null;
    $('hint-message').hidden = true;
    $('win-message').hidden = true;
    updateMoveCounter();
    renderPlayBottles();
  }

  function onReset() {
    if (!currentPuzzle) return;
    playState = cloneState(currentPuzzle.state);
    pastStates = [cloneState(currentPuzzle.state)];
    selectedSlot = null;
    hintHighlight = null;
    $('hint-message').hidden = true;
    $('win-message').hidden = true;
    updateMoveCounter();
    renderPlayBottles();
  }

  function onHint() {
    if (!currentPuzzle) return;
    var msg = $('hint-message');
    msg.hidden = false;
    msg.textContent = 'Thinking…';
    setTimeout(function () {
      var result;
      try {
        result = ColorPour.solve(playState, currentPuzzle.rules, { maxNodes: 200000 });
      } catch (e) {
        msg.textContent = 'Couldn’t determine a hint (solver error).';
        return;
      }
      if (result.solvable === true) {
        if (!result.moves || !result.moves.length) {
          msg.textContent = 'Already solved!';
          hintHighlight = null;
        } else {
          var mv = result.moves[0];
          hintHighlight = { from: mv.from, to: mv.to };
          if (Math.max(mv.from, mv.to) >= visibleSlotCount()) showEmptySlots = true;
          msg.textContent = 'Hint: ' + moveText(mv, currentPuzzle.colors);
        }
      } else if (result.solvable === false) {
        msg.textContent = 'No solution from here — undo some moves.';
        hintHighlight = null;
      } else {
        msg.textContent = 'Couldn’t determine (search limit reached).';
        hintHighlight = null;
      }
      renderPlayBottles();
    }, 20);
  }

  // ---- solution viewer ----
  function renderSolutionStep() {
    if (!currentPuzzle) return;
    var n = (currentPuzzle.solution || []).length;
    var stepText = $('solution-step-text');
    var state = solutionStates[solutionIndex];
    var opts = {};
    if (solutionIndex < n) {
      var mv = currentPuzzle.solution[solutionIndex];
      opts.highlightFrom = mv.from;
      opts.highlightTo = mv.to;
      stepText.textContent = 'Step ' + (solutionIndex + 1) + '/' + n + ': ' + moveText(mv, currentPuzzle.colors);
    } else {
      stepText.textContent = n ? ('Solved! (' + n + ' moves)') : 'No moves needed.';
    }
    renderBottleGroup($('solution-bottles'), state, currentPuzzle.colors, currentPuzzle.rules.capacity, opts);

    var list = $('solution-list');
    list.innerHTML = '';
    (currentPuzzle.solution || []).forEach(function (mv, i) {
      var li = el('li', null, moveText(mv, currentPuzzle.colors));
      if (i === solutionIndex) li.className = 'current';
      list.appendChild(li);
    });
  }

  function onSolutionPrev() {
    if (solutionIndex > 0) { solutionIndex--; renderSolutionStep(); }
  }
  function onSolutionNext() {
    var n = (currentPuzzle.solution || []).length;
    if (solutionIndex < n) { solutionIndex++; renderSolutionStep(); }
  }

  // ---- printable set ----
  // Several puzzles laid out 6 per legal-size page (2 columns x 3 rows), plus
  // an optional answer key. Puzzles are generated one at a time with a yield
  // between each so the progress text can repaint.
  var SET_PER_PAGE = 6;
  var SET_MAX = 60;
  var SET_PAGE_STYLE_ID = 'print-set-page-style';

  function onGenerateSetClick() {
    clearError();
    var config;
    try {
      config = buildGenerationConfig();
    } catch (e) {
      showError(e.message);
      return;
    }
    var count = Math.max(1, Math.min(SET_MAX, parseInt($('batch-count').value, 10) || SET_PER_PAGE));
    $('batch-count').value = count;
    var baseSeed = config.seed;
    var puzzles = [];
    var seen = {};
    var retries = 0;
    var btn = $('batch-generate-btn');
    var progress = $('batch-progress');
    btn.disabled = true;
    progress.hidden = false;

    function finish(errMsg) {
      btn.disabled = false;
      progress.hidden = true;
      if (errMsg) { showError(errMsg); return; }
      renderPrintSheet(puzzles, $('batch-answers').checked);
      $('batch-panel').hidden = false;
      $('batch-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function next() {
      if (puzzles.length >= count) { finish(); return; }
      progress.textContent = 'Generating ' + (puzzles.length + 1) + ' of ' + count + '…';
      setTimeout(function () {
        var c = {
          capacity: config.capacity,
          colors: config.colors,
          pourMode: config.pourMode,
          difficulty: config.difficulty
        };
        // A typed seed makes the whole set reproducible: puzzle k uses
        // "<seed>-k" (plus a retry suffix if it duplicated an earlier one).
        if (baseSeed != null) c.seed = baseSeed + '-' + (puzzles.length + 1) + (retries ? '-r' + retries : '');
        var puzzle;
        try {
          puzzle = ColorPour.generatePuzzle(c, { timeBudgetMs: 1500 });
        } catch (err) {
          finish(err.message || String(err));
          return;
        }
        // Tiny kits have few distinct deals; skip repeats, but don't loop forever.
        var key = ColorPour.canonicalKey(puzzle.state);
        if (seen[key] && retries < 5) { retries++; next(); return; }
        seen[key] = true;
        retries = 0;
        puzzles.push(puzzle);
        next();
      }, 20);
    }
    next();
  }

  // Sizes a card's tubes to fit a ~3.3in x 2.4in area of the card: one row
  // of tubes when they can each be at least 0.2in wide, otherwise balanced
  // rows, with block height shrunk so every row still fits.
  function cardSizing(slotCount, capacity) {
    var widthIn = 3.3, heightIn = 2.4, gapIn = 0.08, minW = 0.2, labelIn = 0.2;
    var perRow = Math.floor((widthIn + gapIn) / (minW + gapIn));
    var rows = Math.ceil(slotCount / perRow);
    var cols = Math.ceil(slotCount / rows);
    var bottleW = Math.min(0.5, (widthIn - gapIn * (cols - 1)) / cols);
    var blockH = Math.max(0.08, Math.min(0.38, (heightIn / rows - labelIn) / capacity));
    return { bottleW: bottleW.toFixed(3) + 'in', blockH: blockH.toFixed(3) + 'in', gap: gapIn + 'in' };
  }

  function buildPrintCard(puzzle, number) {
    var card = el('div', 'print-card');
    var head = el('div', 'print-card-head');
    head.appendChild(el('span', 'print-card-num', 'Puzzle ' + number));
    var meta = puzzle.difficulty ? puzzle.difficulty.charAt(0).toUpperCase() + puzzle.difficulty.slice(1) : '';
    if (puzzle.solution) meta += (meta ? ' · ' : '') + puzzle.solution.length + ' moves';
    head.appendChild(el('span', 'print-card-meta', meta));
    card.appendChild(head);

    var sizing = cardSizing(puzzle.state.length, puzzle.rules.capacity);
    var bottles = el('div', 'bottles-container print-card-bottles');
    bottles.style.setProperty('--card-bottle-w', sizing.bottleW);
    bottles.style.setProperty('--card-block-h', sizing.blockH);
    bottles.style.setProperty('--card-gap', sizing.gap);
    renderBottleGroup(bottles, puzzle.state, puzzle.colors, puzzle.rules.capacity, { static: true });
    card.appendChild(bottles);

    var legend = el('div', 'legend print-card-legend');
    renderLegend(puzzle.colors, legend);
    card.appendChild(legend);
    return card;
  }

  function answerText(puzzle) {
    var labels = computeColorLabels(puzzle.colors);
    return (puzzle.solution || []).map(function (mv) {
      return (mv.from + 1) + '→' + (mv.to + 1) + ' ' + (labels[mv.color] || '?');
    }).join(',  ');
  }

  function renderPrintSheet(puzzles, includeAnswers) {
    var sheet = $('print-sheet');
    sheet.innerHTML = '';
    for (var p = 0; p < puzzles.length; p += SET_PER_PAGE) {
      var page = el('div', 'print-page');
      puzzles.slice(p, p + SET_PER_PAGE).forEach(function (puzzle, i) {
        page.appendChild(buildPrintCard(puzzle, p + i + 1));
      });
      sheet.appendChild(page);
    }
    if (includeAnswers) {
      var answers = el('div', 'print-answers');
      answers.appendChild(el('h3', null, 'Answer key'));
      answers.appendChild(el('p', 'print-answers-note', 'Each move is "from slot → to slot" and the color poured. Slots are numbered left to right.'));
      var list = el('ol', 'print-answers-list');
      puzzles.forEach(function (puzzle) {
        var li = el('li');
        li.appendChild(el('strong', null, puzzle.solution.length + ' moves: '));
        li.appendChild(document.createTextNode(answerText(puzzle)));
        list.appendChild(li);
      });
      answers.appendChild(list);
      sheet.appendChild(answers);
    }
    sheet.lastChild.classList.add('print-last');
  }

  // Page size can't be scoped to part of the document, so the legal-size
  // @page rule only exists while the set is printing; the single-puzzle Print
  // button keeps the user's default paper size.
  function onPrintSetClick() {
    if (!document.getElementById(SET_PAGE_STYLE_ID)) {
      var style = el('style');
      style.id = SET_PAGE_STYLE_ID;
      style.textContent = '@page { size: legal portrait; margin: 0.4in; }';
      document.head.appendChild(style);
    }
    document.body.classList.add('printing-set');
    window.print();
  }

  function onAfterPrint() {
    document.body.classList.remove('printing-set');
    var style = document.getElementById(SET_PAGE_STYLE_ID);
    if (style) style.parentNode.removeChild(style);
  }

  // ---- share via URL hash ----
  function updateUrlHash() {
    if (!currentPuzzle) return;
    try {
      var encoded = ColorPour.encodePuzzle(currentPuzzle);
      history.replaceState(null, '', '#p=' + encoded);
    } catch (e) { /* ignore */ }
  }

  function tryLoadFromHash() {
    var hash = location.hash || '';
    var m = hash.match(/^#p=(.+)$/);
    if (!m) return false;
    try {
      var decoded = ColorPour.decodePuzzle(m[1]);
      if (!decoded || !decoded.state || !decoded.rules) throw new Error('bad puzzle');
      if (!decoded.solution || !decoded.solution.length) {
        var res = ColorPour.solve(decoded.state, decoded.rules, { maxNodes: 200000 });
        decoded.solution = res.moves || [];
      }
      if (!decoded.score) {
        decoded.score = ColorPour.scoreDifficulty(decoded.state, decoded.rules, decoded.solution);
      }
      loadPuzzle(decoded);
      return true;
    } catch (e) {
      showError('Could not load puzzle from link: ' + (e.message || e));
      return false;
    }
  }

  function onCopyLink() {
    updateUrlHash();
    var text = location.href;
    var msg = $('setup-saved-msg');
    function flash(label) {
      msg.textContent = label;
      msg.hidden = false;
      setTimeout(function () { msg.hidden = true; msg.textContent = 'Saved'; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flash('Link copied'); }, function () { prompt('Copy this link:', text); });
    } else {
      prompt('Copy this link:', text);
    }
  }

  // ---- wiring ----
  function init() {
    loadSetup();
    applySetupToForm();

    $('add-color-btn').addEventListener('click', addColorRow);
    $('input-colors').addEventListener('change', function () {
      resizeColorsTo(parseInt($('input-colors').value, 10) || setup.colors.length);
    });
    $('input-capacity').addEventListener('input', updateSlotsReadout);
    $('save-setup-btn').addEventListener('click', function () {
      readSetupBasicsFromForm();
      saveSetup();
      var msg = $('setup-saved-msg');
      msg.hidden = false;
      setTimeout(function () { msg.hidden = true; }, 1500);
    });
    $('reset-setup-btn').addEventListener('click', function () {
      if (!window.confirm('Reset kit setup to defaults? This clears your saved setup.')) return;
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (e) { /* ignore */ }
      setup = defaultSetup();
      applySetupToForm();
    });

    $('generate-btn').addEventListener('click', onGenerateClick);
    $('batch-generate-btn').addEventListener('click', onGenerateSetClick);
    $('batch-print-btn').addEventListener('click', onPrintSetClick);
    window.addEventListener('afterprint', onAfterPrint);

    $('undo-btn').addEventListener('click', onUndo);
    $('reset-btn').addEventListener('click', onReset);
    $('hint-btn').addEventListener('click', onHint);
    $('empty-slots-btn').addEventListener('click', onToggleEmptySlots);
    $('copy-link-btn').addEventListener('click', onCopyLink);
    $('print-btn').addEventListener('click', function () { window.print(); });

    $('sol-prev-btn').addEventListener('click', onSolutionPrev);
    $('sol-next-btn').addEventListener('click', onSolutionNext);

    if (!tryLoadFromHash()) {
      // no puzzle yet; leave puzzle panel hidden until Generate is pressed
    }

    window.addEventListener('hashchange', function () {
      if (location.hash) tryLoadFromHash();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Read-only debug hook for automated testing (e2e). Not part of the UI contract.
  window.ColorPourApp = {
    getState: function () {
      return {
        puzzle: currentPuzzle,
        playState: playState,
        pastStates: pastStates,
        selectedSlot: selectedSlot,
        solutionIndex: solutionIndex
      };
    },
    computeColorLabels: computeColorLabels
  };
})();
