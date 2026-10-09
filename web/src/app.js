/* Open Field coaching interface. All measurements come from OFMetrics. */
(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value));
  const fmt = (value, places = 1) => finite(value) ? Number(value).toFixed(places) : '—';
  const signed = value => finite(value) ? `${Number(value) > 0 ? '+' : ''}${fmt(value)}` : '—';
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  let data = DATA;
  const M = window.OFMetrics;
  const cache = new Map();
  const heatCache = new Map();
  const remembered = new Map();
  const state = {
    a: null, b: null, t: 0, playing: false, speed: 1, mode: 'distance',
    receivers: { a: null, b: null }, focusPlayers: { a: null, b: null }, pairReceivers: { a: null, b: null },
    metricOptions: { scope: 'coverage', threshold: 3, lookback: .5, minDuration: .2, downfieldOnly: true, inBoundsOnly: true },
    layers: { heat: true, opacity: .7, ghosts: true, links: true, arrows: true, rushers: true, blockers: true, contours: false, trail: '.65', labels: 'jersey', shapes: true, mask: 'all', lane: false },
    ui: { tab: 'replay', blind: false, baseline: false, largeText: false, highContrast: false, reducedMotion: false, expanded: false, libraryCollapsed: false, zoom: 1, statsMode: 'full', studyBoard: 'a', chart: 'separation' },
    alignment: 'snap', manualAnchors: { a: 0, b: 0 }, loop: { enabled: false, start: 0, end: 1 },
    filters: { search: '', game: '', offense: '', defense: '', coverage: '', formation: '', down: '', quality: '', penalty: '', sort: 'source' },
    filtered: [], boards: {}, point: null, region: null, preSnap: null,
    lastStamp: null, request: null, lastPaint: '', storyIndex: null
  };
  Object.defineProperties(state, {
    threshold: { get: () => state.metricOptions.threshold, set: value => { state.metricOptions.threshold = Number(value); } },
    downfieldOnly: { get: () => state.metricOptions.downfieldOnly, set: value => { state.metricOptions.downfieldOnly = !!value; } }
  });

  function mount() {
    $('#root').innerHTML = `
      <a class="skip-link" href="#main">Skip to analysis</a>
      <header class="topbar"><a class="brand" href="#"><span class="brand-mark" aria-hidden="true">///</span><span class="brand-name">Open Field<span class="accent">.</span></span><span class="brand-sub">The movement behind the opening</span></a><div class="top-actions"><span class="source-tag" id="sourceTag"></span><button id="settingsButton">View settings</button><button id="methodButton">How to read this ↗</button></div></header>
      <div class="app" id="app"><aside class="sidebar" aria-label="Play library">
        <div class="sidebar-head"><span class="eyebrow">The play library</span><span class="count" id="totalCount"></span></div>
        <label class="sr-only" for="search">Search teams, players or plays</label><input class="search" type="search" id="search" placeholder="Search player, team or play…">
        <div class="filters"><label><span class="filter-label">GAME</span><select id="filterGame"></select></label><label><span class="filter-label">OFFENSE</span><select id="filterOffense"></select></label><label><span class="filter-label">COVERAGE</span><select id="filterCoverage"></select></label><label><span class="filter-label">FORMATION</span><select id="filterFormation"></select></label></div>
        <details class="filter-details"><summary>More filters & sort</summary><div class="filters"><label><span class="filter-label">DEFENSE</span><select id="filterDefense"></select></label><label><span class="filter-label">DOWN</span><select id="filterDown"><option value="">Any down</option><option>1</option><option>2</option><option>3</option><option>4</option></select></label><label><span class="filter-label">QUALITY</span><select id="filterQuality"><option value="">All observations</option><option value="clean">No flagged issues</option><option value="flagged">Review flags</option></select></label><label><span class="filter-label">PENALTIES</span><select id="filterPenalty"><option value="">All plays</option><option value="exclude">Exclude penalties</option><option value="only">Penalized only</option><option value="nullified">Nullified only</option></select></label><label class="span-all"><span class="filter-label">SORT</span><select id="sortPlays"><option value="source">Game order</option><option value="duration">Longest observation</option><option value="window">Longest eligible distance window</option><option value="lift">Largest positive Coverage Lift</option></select></label></div></details>
        <div class="library-actions"><span id="listStatus" aria-live="polite"></span><button id="resetFilters" class="text-button">Reset</button></div><div id="hiddenSelection" class="notice hidden">The selected play is outside these filters.</div><div class="play-list" id="playList"></div><div class="side-footer" id="librarySource"></div>
      </aside><main class="main" id="main">
        <div class="intro"><div><div class="eyebrow">A new lens on off-ball movement</div><h1>Who made the room?</h1><p><strong>Coverage Lift</strong> separates the spacing effect of defensive movement from receiver movement.</p></div><div class="intro-actions"><button id="compareButton" aria-pressed="false">⇄ Compare plays</button><button id="exportButton">↓ Export view</button></div></div>
        <div class="story-bar future-content" id="storyBar"><div><label class="eyebrow" for="storySelect">Start with an observed example</label><select id="storySelect"></select><p id="storyCaption"></p></div><button id="storyCompare">Compare example ⇄</button></div>
        <nav class="view-tabs" aria-label="Analysis views"><button data-tab="replay" class="active">Field & Lift</button><button data-tab="routes">Routes & openings</button><button data-tab="compare">Find a comparison</button><button data-tab="review">Coaching workspace</button></nav>
        <div class="toolbar metric-surface"><div class="segmented" role="group" aria-label="Field metric"><button data-mode="distance" class="active">Space now</button><button data-mode="change">Space change</button><button data-mode="none">Tracking only</button></div><label class="compact-control">Defenders<select id="roleScope"><option value="coverage">Coverage role</option><option value="all">All defenders</option></select></label><label class="compact-control">Lookback<select id="lookback"><option value=".2">0.2 s</option><option value=".5" selected>0.5 s</option><option value="1">1.0 s</option></select></label><label class="threshold-control" for="threshold"><span>Distance threshold</span><input type="range" id="threshold" min="2" max="5" step=".5" value="3"><output id="thresholdValue">3.0 yd</output></label></div>
        <div class="comparison-controls hidden" id="compareControls"><label for="compareSelect">Play B</label><select id="compareSelect"></select><label class="compact-control">Align<select id="alignment"><option value="snap">At snap</option><option value="release">At observed endpoint</option><option value="firstWindow">At first eligible window</option><option value="firstDownfield">At first downfield arrival</option><option value="manual">At chosen times</option></select></label><span id="manualAlignment" class="hidden manual-alignment"><label>A anchor <input id="manualAnchorA" type="number" min="0" step=".1" value="0"></label><label>B anchor <input id="manualAnchorB" type="number" min="0" step=".1" value="0"></label><button id="captureAnchors">Use current observations</button></span><button id="swapCompare" title="Swap A and B">⇄</button><button id="removeCompare" aria-label="Remove comparison">×</button></div>
        <div id="workspaceToolbar"></div>
        <div class="transport" aria-label="Replay controls"><div class="transport-buttons"><button id="resetButton" aria-label="Back to beginning">↤</button><button id="stepBack" aria-label="Previous frame">‹</button><button id="playButton" class="primary" aria-label="Play replay">▶</button><button id="stepForward" aria-label="Next frame">›</button></div><span id="currentTime" class="time-label">0.0 s</span><div class="scrub-area"><label class="sr-only" for="scrubber">Replay time</label><input type="range" id="scrubber" min="0" max="4" step=".01" value="0"><span id="endTime" class="max-time"></span></div><select id="speed" class="speed" aria-label="Playback speed"><option value=".25">0.25×</option><option value=".5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select><button id="loopButton" aria-pressed="false">↻ Loop</button></div>
        <div class="transport-note"><span id="clockDescription">Seconds after snap · same clock and scales</span><span>Space: play · ←/→: frame · [ / ]: window · F: field</span></div>
        <div class="loop-controls hidden" id="loopControls"><label>In <input id="loopStart" type="number" min="0" step=".1" value="0"></label><label>Out <input id="loopEnd" type="number" min=".1" step=".1" value="1"></label><button id="loopHere">Loop this second</button><span>Loop points use the aligned replay clock.</span></div>
        <section data-panel="replay" id="replayPanel"><div class="boards" id="boards"></div><details class="inspector-drawer metric-surface" open><summary>Inspect a location or a region <span>Click empty grass to pin · drag to select a region</span></summary><div id="pointInspector"><p class="empty-inline">Move over the field to inspect exact spacing. Click a point to hold it, or drag a region to study openings and arrivals.</p></div><div class="point-entry"><label>Play<select id="inspectBoard"><option value="a">A</option><option value="b">B</option></select></label><label>Field x (yd)<input id="inspectX" type="number" min="0" max="120" step=".5" value="60"></label><label>Field y (yd)<input id="inspectY" type="number" min="0" max="53.3" step=".5" value="26.65"></label><button id="inspectCoordinates">Pin coordinates</button><span>Keyboard: focus the field, Ctrl + arrows moves a pin by 1 yd.</span></div><div class="region-actions"><button id="clearRegion">Clear pin / region</button><button id="analyzeRegion">Analyze selected region</button><label>Region threshold <span id="regionThreshold">3.0 yd</span></label></div><div id="regionResults"></div></details></section>
        <section data-panel="routes" class="hidden" id="routesPanel"><div class="panel-card metric-surface"><div class="panel-heading"><div><span class="eyebrow">Every route, one clock</span><h2>Who had space, and when?</h2></div><label class="compact-control">Study play<select id="studyBoard"><option value="a">Play A</option><option value="b">Play B</option></select></label></div><div class="window-controls"><label><input id="downfieldOnly" type="checkbox" checked>Downfield windows only</label><label><input id="inBoundsOnly" type="checkbox" checked>In bounds only</label><label>Minimum hold<select id="minDuration"><option value="0">Any interval</option><option value=".2" selected>0.2 s</option><option value=".3">0.3 s</option><option value=".5">0.5 s</option></select></label><label>Statistics<select id="statsMode"><option value="full">Whole observed play</option><option value="sofar">Observed so far</option></select></label></div><canvas id="allRoutesTimeline" class="all-routes-canvas" role="img" aria-label="All receiver distance windows on one timeline"></canvas><div id="allRoutesTable"></div></div>
        <div class="panel-card metric-surface"><div class="panel-heading"><div><span class="eyebrow">Opening and closing</span><h2>Moments worth a closer look</h2></div><div class="inline-actions"><button id="previousWindow">← Previous</button><button id="nextWindow">Next →</button><button id="jumpPeak">Peak lift</button><button id="jumpRelease">Endpoint</button></div></div><div id="eventList"></div></div>
        <div class="diagnostic-grid metric-surface"><details class="panel-card"><summary>Which defenders contribute to Coverage Lift?</summary><p>Geometric allocation across defender movements, with interactions shared. This is not blame or a coverage assignment.</p><button id="analyzeContributions">Calculate this frame</button><div id="contributionResults"></div></details><details class="panel-card"><summary>Possible off-ball route connections</summary><p>Find receiver–defender co-movement associated with a teammate’s space. These are review candidates, not causal decoy credit.</p><button id="analyzeAssists">Find linked movement</button><div id="assistResults"></div></details><details class="panel-card"><summary>Does the finding survive different settings?</summary><p>Compare thresholds, lookbacks and small position perturbations before treating a peak as a stable observation.</p><button id="analyzeSensitivity">Check sensitivity</button><div id="sensitivityResults"></div></details><details class="panel-card"><summary>Four distances, no black box</summary><div id="fourDistances"></div><p>Coverage Lift averages the defensive movement effect with the receiver held at each endpoint. Receiver Lift is the complementary component. Together they equal the observed separation change.</p></details></div></section>
        <section data-panel="compare" class="hidden"><div class="panel-card"><div class="panel-heading"><div><span class="eyebrow">Find a fairer comparison</span><h2>Similar situations. Different movement.</h2></div><span id="matchCount" class="count"></span></div><input type="search" id="comparisonSearch" class="search" placeholder="Search comparison players, teams or formations…"><div class="window-controls"><label><input id="matchOffense" type="checkbox">Same offense</label><label><input id="matchCoverage" type="checkbox" checked>Same coverage</label><label><input id="matchFormation" type="checkbox">Same formation</label><label><input id="matchDown" type="checkbox">Same down</label><button id="compareSamePlay">Compare two receivers on this play</button></div><p class="help-text">Matches use observed context, not an assumption that plays are interchangeable. Sample sizes and mismatches remain visible.</p><div id="matchList"></div></div></section>
        <section data-panel="review" class="hidden"><section id="workspaceTools"></section></section><div id="workspaceStatus" role="status" aria-live="polite" class="workspace-status"></div><footer class="product-footer"><span>Positioning is observed. Intent is interpreted.</span><span id="cohortSummary"></span></footer>
      </main></div>
      <dialog id="settingsDialog"><div class="dialog-head"><h2>Make the field yours.</h2><button data-close="settingsDialog" aria-label="Close settings">×</button></div><div class="dialog-body settings-grid"><fieldset><legend>Field layers</legend>${['heat:Heatmap','ghosts:Prior defender reference positions','links:Nearest defender connection','arrows:Motion direction arrows','rushers:Pass rushers','blockers:Pass blockers','contours:Threshold contour','lane:Exploratory quarterback-to-receiver lane'].map(s => { const [id, label] = s.split(':'); return `<label><input data-layer="${id}" type="checkbox" ${!['contours', 'lane'].includes(id) ? 'checked' : ''}>${label}</label>`; }).join('')}<label>Heatmap region<select id="heatMask"><option value="all">Entire field in view</option><option value="downfield">At or beyond line of scrimmage</option><option value="routes">Within 8 yd of current route runners</option><option value="region">Inside selected region</option></select></label><label>Heatmap opacity<input id="heatOpacity" type="range" min=".15" max="1" step=".05" value=".7"></label><label>Route trail<select id="trailLength"><option value=".65">Recent 0.65 s</option><option value="1.5">Recent 1.5 s</option><option value="full">Observed so far</option><option value="whole">Whole observed route</option><option value="none">No trail</option></select></label><label>Player labels<select id="labelMode"><option value="jersey">Jersey</option><option value="name">Name</option><option value="none">None</option></select></label></fieldset><fieldset><legend>Readability & access</legend><label><input id="largeText" type="checkbox">Larger interface text</label><label><input id="highContrast" type="checkbox">Higher contrast</label><label><input id="shapeMarkers" type="checkbox" checked>Distinct offense / defense shapes</label><label><input id="reducedMotion" type="checkbox">Reduced animation</label><label>Zoom<select id="fieldZoom"><option value="1">Fit the field</option><option value="1.25">1.25× near selection</option><option value="1.6">1.6× near selection</option><option value="2">2× near selection</option></select></label><button id="fullscreenButton">Expand field view</button><button id="collapseLibrary">Show / hide play library</button><button id="preSnapButton">Inspect available pre-snap frames</button><div id="preSnapControls" class="hidden"><input id="preSnapSlider" type="range" min="0" max="0" step="1" value="0"><span id="preSnapStatus"></span><button id="returnSnap">Return to snap</button></div></fieldset></div></dialog>
      <dialog id="methodDialog"><div class="dialog-head"><h2>The metric behind the picture.</h2><button id="closeMethod" aria-label="Close method">×</button></div><div class="dialog-body"><h3>Coverage Lift · signed yards</h3><p>Compare the receiver and defense now with their positions one lookback earlier. Compute nearest-defender distance for all four old/new combinations.</p><div class="method-formula"><strong>Coverage Lift</strong> = ½ × [(defense moved − start) + (end − receiver moved)]<br><strong>Receiver Lift</strong> = ½ × [(receiver moved − start) + (end − defense moved)]<br><strong>The components sum to the observed separation change.</strong></div><p>Positive adds spacing; negative reduces it. Averaging both movement orders shares interactions without choosing an order. This is a geometric reference, not a counterfactual play or proof of a route’s causal effect. Do not add overlapping rolling lift values into “total yards created.”</p><h3>Space and change maps</h3><p>Space is nearest-defender distance in the chosen role scope, on a fixed 0–8+ yard scale. Change compares the same field location over the lookback, on a fixed −4 to +4 yard scale. No estimate is shown without sufficient history. Rushers count only in all-defender mode.</p><h3>Distance windows</h3><p>Windows meet the threshold, eligibility conditions and minimum hold. Duration counts observed intervals. Censoring marks windows already open at the eligible start or still open at the endpoint. “So far” uses only observations through the current frame. These are descriptive settings, not calibrated catch-probability rules.</p><h3>Interpretation & controls</h3><p>Distance omits throw feasibility, reaction and intent. A nearest-defender switch is not a verified handoff. Contributions and associations are geometric, not responsibility or causal credit. Click any player; shift-click a receiver to add a pair. Click grass to pin or drag to select a region. Arrows show motion direction. Both offenses face right. Charts have companion tables, and comparison endpoints are explicit.</p><div id="methodSource" class="source-detail"></div></div></dialog><div id="fieldTooltip" class="field-tooltip hidden" aria-hidden="true"></div>`;
  }

  const plays = () => data.plays || [];
  const byId = id => plays().find(play => String(play.id) === String(id));
  const getPlay = key => byId(state[key]);
  const routes = play => play?.players.filter(player => player.role === 'route' && player.side === 'offense') || [];
  const playerById = (play, id) => play?.players.find(player => String(player.id) === String(id));
  const endTime = play => Number(play?.times?.at(-1) || 0);
  const name = (play, id) => playerById(play, id)?.name || 'Unavailable';
  const currentKeys = () => state.b ? ['a', 'b'] : ['a'];
  const options = extra => ({ ...state.metricOptions, ...extra });
  const optionKey = () => JSON.stringify(state.metricOptions);
  const frameAt = (play, time) => M.frameAt(play, time);

  function memo(key, build) {
    if (!cache.has(key)) cache.set(key, build());
    if (cache.size > 1800) cache.delete(cache.keys().next().value);
    return cache.get(key);
  }

  function series(play, id) {
    return memo(`s:${play.id}:${id}:${optionKey()}`, () => M.series(play, id, options()));
  }

  function windows(play, id, throughTime) {
    const opts = options(finite(throughTime) ? { throughTime } : {});
    return memo(`w:${play.id}:${id}:${JSON.stringify(opts)}`, () => M.windows(play, id, opts));
  }

  function defaultReceiver(play) {
    // In practice mode choose from snap position only, never a future window.
    if (state.ui.blind) return String([...routes(play)].sort((a, b) => Number(b.track[0]?.[0] ?? -Infinity) - Number(a.track[0]?.[0] ?? -Infinity) || String(a.id).localeCompare(String(b.id)))[0]?.id || '') || null;
    const saved = remembered.get(String(play.id));
    if (saved && playerById(play, saved)) return saved;
    const ranked = routes(play).map(player => ({ id: String(player.id), window: windows(play, player.id).total || 0 }));
    ranked.sort((a, b) => b.window - a.window);
    return ranked[0]?.id || null;
  }

  function anchor(key) {
    const play = getPlay(key);
    if (!play || state.alignment === 'snap') return 0;
    if (state.alignment === 'release') return endTime(play);
    if (state.alignment === 'manual') return clamp(Number(state.manualAnchors[key]) || 0, 0, endTime(play));
    if (state.alignment === 'firstDownfield') {
      const receiver = playerById(play, state.receivers[key]);
      const index = receiver?.track.findIndex(pos => finite(pos?.[0]) && pos[0] >= play.los);
      return index >= 0 ? Number(play.times[index]) : 0;
    }
    return windows(play, state.receivers[key]).intervals?.[0]?.start ?? 0;
  }

  function offset(key) {
    if (!state.b || state.alignment === 'snap') return 0;
    return anchor(key) - Math.max(...currentKeys().map(anchor));
  }

  const rawTime = key => state.t + offset(key);
  const boardTime = key => clamp(rawTime(key), 0, endTime(getPlay(key)));
  const observedTime = key => state.preSnap?.key === key ? Number(getPlay(key)?.preSnap?.times?.[state.preSnap.index] ?? boardTime(key)) : Number(getPlay(key)?.times?.[frame(key)] ?? boardTime(key));
  const duration = () => Math.max(.1, ...currentKeys().map(key => endTime(getPlay(key)) - offset(key)));
  const chartDuration = () => state.ui.blind ? Math.max(10, Math.ceil(state.t)) : duration();
  const frame = key => frameAt(getPlay(key), boardTime(key));
  const studyKey = () => state.ui.studyBoard === 'b' && state.b ? 'b' : 'a';
  const statsThrough = key => state.ui.blind || state.ui.statsMode === 'sofar' ? boardTime(key) : undefined;
  const context = key => M.context(getPlay(key), state.receivers[key], frame(key), options());

  function getSnapshot() {
    return JSON.parse(JSON.stringify({ version: 2, a: state.a, b: state.b, t: state.t, speed: state.speed, mode: state.mode, receivers: state.receivers, focusPlayers: state.focusPlayers, pairReceivers: state.pairReceivers, metricOptions: state.metricOptions, layers: state.layers, alignment: state.alignment, manualAnchors: state.manualAnchors, loop: state.loop, filters: state.filters, ui: state.ui, point: state.point, region: state.region, preSnap: state.preSnap }));
  }

  function notify(reason) {
    document.dispatchEvent(new CustomEvent('openfield:change', { detail: { reason, snapshot: getSnapshot() } }));
  }

  function status(message) {
    $('#workspaceStatus').textContent = message;
  }

  function clearDiagnostics() {
    for (const id of ['contributionResults', 'assistResults', 'sensitivityResults', 'regionResults']) {
      $(`#${id}`).innerHTML = '';
    }
  }

  function clearStory() {
    state.storyIndex = null;
    $('#storySelect').value = '';
    $('#storyCaption').textContent = 'Choose an example to jump to a documented movement pattern.';
    $('#storyCompare').classList.add('hidden');
  }

  function selectPlay(key, id, config = {}) {
    const play = byId(id);
    if (!play || !['a', 'b'].includes(key)) throw new Error('Unknown play selection.');
    pause();
    state[key] = String(id);
    state.receivers[key] = defaultReceiver(play);
    state.focusPlayers[key] = state.receivers[key];
    state.pairReceivers[key] = null;
    state.preSnap = null;
    if (key === 'a' && !config.preserveTime) state.t = 0;
    state.t = clamp(state.t, 0, duration());
    state.loop.enabled = false;
    state.point = null; state.region = null;
    clearStory(); clearDiagnostics();
    rebuildBoards(); renderLibrary(); renderMatches(); syncControls(); render();
    notify('play');
  }

  function chooseReceiver(key, id, pair = false) {
    const play = getPlay(key);
    if (!routes(play).some(player => String(player.id) === String(id)) && id !== '') return;
    if (pair) state.pairReceivers[key] = id || null;
    else {
      state.receivers[key] = String(id);
      state.focusPlayers[key] = String(id);
      remembered.set(String(play.id), String(id));
    }
    clearStory(); clearDiagnostics(); syncBoardControls(); render();
    notify(pair ? 'pair' : 'receiver');
  }

  function setTab(tab) {
    if (!['replay', 'routes', 'compare', 'review'].includes(tab)) return;
    state.ui.tab = tab;
    $$('[data-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.panel !== tab));
    $$('[data-tab]').forEach(button => { button.classList.toggle('active', button.dataset.tab === tab); button.setAttribute('aria-current', button.dataset.tab === tab ? 'page' : 'false'); });
    if (tab === 'compare') renderMatches();
    requestAnimationFrame(() => render(true));
    notify('tab');
  }

  function validateSnapshot(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The view is not a valid saved state.');
    const candidate = getSnapshot();
    for (const key of ['a', 'b', 'mode', 'alignment', 't', 'speed', 'point', 'region', 'preSnap']) if (Object.prototype.hasOwnProperty.call(input, key)) candidate[key] = input[key];
    for (const key of ['receivers', 'focusPlayers', 'pairReceivers', 'metricOptions', 'layers', 'ui', 'loop', 'filters', 'manualAnchors']) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      if (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key])) throw new Error(`Invalid ${key} settings.`);
      candidate[key] = { ...candidate[key], ...input[key] };
    }
    if (!candidate.a || !byId(candidate.a) || candidate.b && !byId(candidate.b)) throw new Error('A saved play is not in the loaded game pack.');
    if (!['coverage', 'all'].includes(candidate.metricOptions.scope)) throw new Error('Unknown defender scope.');
    for (const [key, low, high] of [['threshold', .1, 20], ['lookback', .1, 3], ['minDuration', 0, 10]]) {
      const value = Number(candidate.metricOptions[key]);
      if (!Number.isFinite(value) || value < low || value > high) throw new Error(`Invalid ${key} setting.`);
      candidate.metricOptions[key] = value;
    }
    if (!['snap', 'release', 'firstWindow', 'firstDownfield', 'manual'].includes(candidate.alignment)) throw new Error('Unknown alignment.');
    if (!['distance', 'change', 'none'].includes(candidate.mode)) throw new Error('Unknown field metric.');
    if (!['all', 'downfield', 'routes', 'region'].includes(candidate.layers.mask)) throw new Error('Unknown heatmap region.');
    for (const [value, low, high, label] of [[candidate.t, 0, 120, 'time'], [candidate.layers.opacity, 0, 1, 'opacity'], [candidate.ui.zoom, 1, 2, 'zoom'], [candidate.manualAnchors.a, 0, 120, 'A anchor'], [candidate.manualAnchors.b, 0, 120, 'B anchor']]) {
      if (!Number.isFinite(Number(value)) || Number(value) < low || Number(value) > high) throw new Error(`Invalid ${label}.`);
    }
    if (![.25, .5, 1, 2].includes(Number(candidate.speed))) throw new Error('Invalid replay speed.');
    if (!['replay', 'routes', 'compare', 'review'].includes(candidate.ui.tab)) throw new Error('Unknown view.');
    if (candidate.preSnap) {
      const { key, index } = candidate.preSnap;
      if (!['a', 'b'].includes(key) || !candidate[key] || !Number.isInteger(index) || index < 0 || index >= (byId(candidate[key]).preSnap?.times?.length || 0)) throw new Error('This saved pre-snap frame is not available.');
    }
    for (const key of ['point', 'region']) if (candidate[key]) {
      const point = candidate[key], coordinates = key === 'point' ? ['x', 'y'] : ['xMin', 'xMax', 'yMin', 'yMax'];
      if (!['a', 'b'].includes(point.key) || !candidate[point.key] || coordinates.some(coordinate => !Number.isFinite(Number(point[coordinate])) || Number(point[coordinate]) < 0 || Number(point[coordinate]) > (coordinate.startsWith('x') ? 120 : 53.3))) throw new Error(`Invalid field ${key}.`);
      if (key === 'region' && (point.xMin > point.xMax || point.yMin > point.yMax)) throw new Error('Invalid region bounds.');
    }
    return candidate;
  }

  function setSnapshot(snapshot) {
    snapshot = validateSnapshot(snapshot);
    if (!snapshot || typeof snapshot !== 'object') throw new Error('The view is not a valid saved state.');
    if (snapshot.a && !byId(snapshot.a)) throw new Error('This saved play is not in the loaded game pack.');
    if (snapshot.b && !byId(snapshot.b)) throw new Error('The comparison play is not in the loaded game pack.');
    pause();
    for (const key of ['a', 'b', 'mode', 'alignment']) if (key in snapshot) state[key] = snapshot[key];
    for (const key of ['receivers', 'focusPlayers', 'pairReceivers', 'metricOptions', 'layers', 'ui', 'loop', 'filters', 'manualAnchors']) if (snapshot[key]) Object.assign(state[key], snapshot[key]);
    if (!['coverage', 'all'].includes(state.metricOptions.scope)) throw new Error('Unknown defender scope.');
    for (const [key, low, high] of [['threshold', .1, 20], ['lookback', .1, 3], ['minDuration', 0, 10]]) {
      const value = Number(state.metricOptions[key]);
      if (!Number.isFinite(value) || value < low || value > high) throw new Error(`Invalid ${key} setting.`);
      state.metricOptions[key] = value;
    }
    if (!['snap', 'release', 'firstWindow', 'firstDownfield', 'manual'].includes(state.alignment)) state.alignment = 'snap';
    if (state.ui.blind && ['release', 'firstWindow', 'firstDownfield'].includes(state.alignment)) state.alignment = 'snap';
    if (!['distance', 'change', 'none'].includes(state.mode)) state.mode = 'distance';
    for (const key of currentKeys()) {
      if (!routes(getPlay(key)).some(player => String(player.id) === String(state.receivers[key]))) state.receivers[key] = defaultReceiver(getPlay(key));
      if (!playerById(getPlay(key), state.focusPlayers[key])) state.focusPlayers[key] = state.receivers[key];
    }
    state.t = clamp(Number(snapshot.t) || 0, 0, duration());
    state.speed = [.25, .5, 1, 2].includes(Number(snapshot.speed)) ? Number(snapshot.speed) : state.speed;
    state.point = snapshot.point || null; state.region = snapshot.region || null;
    state.preSnap = null;
    if (snapshot.preSnap) {
      const key = snapshot.preSnap.key, index = Number(snapshot.preSnap.index);
      if (!currentKeys().includes(key) || !Number.isInteger(index) || index < 0 || index >= (getPlay(key).preSnap?.times?.length || 0)) throw new Error('This saved pre-snap frame is not available.');
      state.preSnap = { key, index };
    }
    cache.clear(); heatCache.clear(); clearStory(); clearDiagnostics();
    populateFilters(); applyFilters(); rebuildBoards(); syncControls(); setTab(state.ui.tab); render(true);
    notify('restore');
    return getSnapshot();
  }

  function populateFilters() {
    const fill = (id, entries, all) => {
      const values = [...new Set(entries.filter(value => value !== undefined && value !== null && value !== ''))].sort((a, b) => String(a).localeCompare(String(b)));
      $(`#${id}`).innerHTML = `<option value="">${all}</option>${values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('')}`;
    };
    const games = new Map(plays().map(play => [String(play.gameId), `${play.awayTeam} @ ${play.homeTeam}`]));
    $('#filterGame').innerHTML = '<option value="">All games</option>' + [...games].map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join('');
    fill('filterOffense', plays().map(play => play.offense), 'All offenses');
    fill('filterDefense', plays().map(play => play.defense), 'All defenses');
    fill('filterCoverage', plays().map(play => play.coverage), 'All coverages');
    fill('filterFormation', plays().map(play => play.formation), 'All formations');
    const links = { game: 'filterGame', offense: 'filterOffense', defense: 'filterDefense', coverage: 'filterCoverage', formation: 'filterFormation', down: 'filterDown', quality: 'filterQuality', penalty: 'filterPenalty', sort: 'sortPlays' };
    for (const [key, id] of Object.entries(links)) $(`#${id}`).value = state.filters[key];
    $('#search').value = state.filters.search;
    $('#totalCount').textContent = `${plays().length} plays`;
    $('#sourceTag').textContent = `Real tracking · ${data.meta?.season || 'Season unknown'}`;
    $('#librarySource').textContent = `${data.meta?.gameCount || games.size} games · ${data.meta?.season || 'Unknown season'} · observed positions and PFF roles.`;
    const cohort = data.meta?.cohortCounts;
    $('#cohortSummary').textContent = cohort ? `${cohort.included ?? plays().length} included · ${cohort.eligible ?? '—'} unflagged eligible · ${cohort.nullified ?? 0} nullified` : `${plays().length} observed plays · inspect sample context before comparisons`;
    $('#methodSource').innerHTML = `<strong>Source:</strong> ${esc(data.meta?.season)} NFL tracking / PFF scouting. ${plays().length} plays, ${esc(data.meta?.gameCount)} games.<br>Revision: ${esc(data.meta?.sourceRevision || 'unrecorded')}<br>${esc(data.meta?.note || '')}<br><a href="https://github.com/ThompsonJamesBliss/nfl-big-data-bowl-regional-event-data" target="_blank" rel="noopener noreferrer">Source repository ↗</a>`;
  }

  function qualityFlags(play) {
    return Array.isArray(play.quality?.flags) ? play.quality.flags : [];
  }

  function outcome(play) {
    return ({ C: 'Complete', I: 'Incomplete', S: 'Sack', IN: 'Intercepted', R: 'Scramble' })[play.result] || play.result || 'Observed play';
  }

  function searchText(play) {
    return [play.id, play.playId, play.offense, play.defense, play.coverage, play.formation, ...(state.ui.blind ? [] : [play.description]), ...play.players.map(player => player.name)].join(' ').toLowerCase();
  }

  function applyFilters() {
    const f = state.filters, query = f.search.trim().toLowerCase();
    state.filtered = plays().filter(play => {
      if (f.game && String(play.gameId) !== f.game) return false;
      if (f.offense && play.offense !== f.offense) return false;
      if (f.defense && play.defense !== f.defense) return false;
      if (f.coverage && play.coverage !== f.coverage) return false;
      if (f.formation && play.formation !== f.formation) return false;
      if (f.down && String(play.down) !== f.down) return false;
      if (query && !searchText(play).includes(query)) return false;
      if (!state.ui.blind && f.quality === 'clean' && qualityFlags(play).length) return false;
      if (!state.ui.blind && f.quality === 'flagged' && !qualityFlags(play).length) return false;
      if (!state.ui.blind && f.penalty === 'exclude' && play.penalty?.hasPenalty) return false;
      if (!state.ui.blind && f.penalty === 'only' && !play.penalty?.hasPenalty) return false;
      if (!state.ui.blind && f.penalty === 'nullified' && !play.penalty?.nullified) return false;
      return true;
    });
    const sort = state.ui.blind ? 'source' : f.sort;
    if (sort === 'duration') state.filtered.sort((a, b) => endTime(b) - endTime(a));
    if (sort === 'window' || sort === 'lift') {
      const score = play => memo(`sort:${play.id}:${sort}:${optionKey()}`, () => Math.max(0, ...routes(play).map(player => sort === 'window' ? windows(play, player.id).longest || 0 : Math.max(0, ...series(play, player.id).map(record => Number(record.coverage) || 0)))));
      state.filtered.sort((a, b) => score(b) - score(a));
    }
    renderLibrary();
  }

  function renderLibrary() {
    $('#listStatus').textContent = `${state.filtered.length} matching plays`;
    $('#hiddenSelection').classList.toggle('hidden', state.filtered.some(play => String(play.id) === String(state.a)));
    $('#playList').innerHTML = state.filtered.length ? state.filtered.map(play => `
      <button class="play-option ${String(play.id) === String(state.a) ? 'active' : ''}" data-play="${esc(play.id)}" aria-pressed="${String(play.id) === String(state.a)}">
      <span class="play-option-top"><span>${esc(play.offense)} <span class="muted">vs</span> ${esc(play.defense)}</span><span class="result-pill">${state.ui.blind ? '' : esc(outcome(play))}</span></span>
      <span class="play-option-meta">Q${esc(play.quarter)} · ${esc(play.clock)} · ${esc(play.down)} & ${esc(play.yardsToGo)}</span>
      <span class="play-option-meta">${esc(play.coverage || 'Coverage unknown')} · ${esc(play.formation || 'Formation unknown')}</span>
      ${!state.ui.blind && play.penalty?.nullified ? '<span class="quality-badge">Nullified</span>' : ''}${!state.ui.blind && qualityFlags(play).length ? '<span class="quality-badge">Review flags</span>' : ''}</button>`).join('') : '<p class="empty">No plays match. Try another filter or reset the library.</p>';
    $$('[data-play]').forEach(button => button.addEventListener('click', () => selectPlay('a', button.dataset.play)));
  }

  function playLabel(play) {
    return `${play.offense} vs ${play.defense} · Q${play.quarter} ${play.clock} · ${play.coverage || 'Unknown coverage'} · ${play.playId}`;
  }

  function populateComparison() {
    $('#compareSelect').innerHTML = plays().map(play => `<option value="${esc(play.id)}">${esc(playLabel(play))}</option>`).join('');
    if (state.b) $('#compareSelect').value = state.b;
    $('#compareControls').classList.toggle('hidden', !state.b);
    $('#compareButton').setAttribute('aria-pressed', String(!!state.b));
    $('#compareButton').textContent = state.b ? '⇄ Comparing plays' : '⇄ Compare plays';
    $('#studyBoard option[value="b"]').disabled = !state.b;
    let explanation = $('#comparisonReason');
    if (!explanation) { explanation = document.createElement('p'); explanation.id = 'comparisonReason'; explanation.className = 'help-text'; $('#compareControls').after(explanation); }
    explanation.classList.toggle('hidden', !state.b);
    if (state.b) {
      const match = M.compareMatches(getPlay('a'), [getPlay('b')], options({ includeSame: true, limit: 1 }))[0];
      explanation.textContent = state.a === state.b ? 'Same observed play, two receiver views. Both boards share the play clock and field scale.' : `Context match ${fmt((match?.score || 0) * 100, 0)}%. Shared: ${(match?.reasons || []).join(', ') || 'no recorded match'}. Differences: ${(match?.mismatches || []).map(item => typeof item === 'string' ? item : item.field).join(', ') || 'none among compared fields'}. Context similarity does not make these plays interchangeable.`;
    }
  }

  function boardHTML(key) {
    const play = getPlay(key), optionsHTML = routes(play).map(player => `<option value="${esc(player.id)}">#${esc(player.jersey)} ${esc(player.name)}</option>`).join('');
    const flags = qualityFlags(play);
    return `<section class="board" data-board="${key}" aria-label="Play ${key.toUpperCase()}: ${esc(playLabel(play))}">
      <header class="board-head"><div><div class="board-label"><span class="board-badge">${key.toUpperCase()}</span>${esc(play.offense)} <span class="muted">vs</span> ${esc(play.defense)}</div><div class="board-context">Q${esc(play.quarter)} · ${esc(play.clock)} · ${esc(play.down)} & ${esc(play.yardsToGo)} · ${esc(play.formation || '—')}</div><span class="scheme-badge">${esc(play.coverage || 'Coverage unknown')}</span>${flags.length ? `<span class="quality-badge future-content" title="${esc(flags.join('; '))}">${flags.length} review flag${flags.length === 1 ? '' : 's'}</span>` : ''}${play.penalty?.hasPenalty ? `<span class="quality-badge future-content">${play.penalty.nullified ? 'Nullified play' : 'Penalty'}</span>` : ''}</div><div class="board-actions"><button data-expand="${key}" title="Expand field">⛶</button></div></header>
      <div class="board-body"><div class="field-wrap"><div class="field-toolbar"><span class="field-clock"></span><span>OFFENSE <strong>→</strong></span></div><canvas class="field-canvas" tabindex="0" role="img" aria-label="Observed player positions and field spacing"></canvas><div class="history-note hidden"></div><div class="field-legend"><div class="field-legend-top"><div class="color-key"><span>● Offense</span><span>◇ Defense</span><span>○ Reference</span></div><span class="scope-label"></span></div><div class="heat-key"><span class="legend-low"></span><span><span class="gradient"></span><span class="heat-ticks"></span></span><span class="legend-high"></span></div><span class="field-time-note">Arrows: motion direction · ghosts: prior positions</span></div></div>
      <div class="analysis-panel"><div class="receiver-tools"><label for="receiver-${key}">FOLLOW A RECEIVER</label><select id="receiver-${key}" ${optionsHTML ? '' : 'disabled'}>${optionsHTML || '<option>No route runner</option>'}</select></div>
      <details class="context-details"><summary>Inspect players & pair routes</summary><div class="player-tools"><label>Inspect any player<select id="focus-${key}">${play.players.map(player => `<option value="${esc(player.id)}">${esc(player.name)} · ${esc(player.role)}</option>`).join('')}</select></label><label>Pair a receiver<select id="pair-${key}"><option value="">No paired route</option>${optionsHTML}</select></label></div><div class="focus-player"></div></details>
      <div class="lift-cards metric-surface"><div class="lift-card primary-lift"><div class="lift-value coverage-lift">—</div><div class="lift-label">Coverage Lift · yd</div></div><div class="lift-card"><div class="lift-value receiver-lift">—</div><div class="lift-label">Receiver Lift · yd</div></div><div class="lift-card"><div class="lift-value net-lift">—</div><div class="lift-label">Net spacing change · yd</div></div></div><div class="metric-equation metric-surface"></div>
      <div class="timeline-tabs metric-surface"><button data-chart="separation">Separation</button><button data-chart="lift">Lift components</button><button data-chart="pair">Paired routes</button></div><div class="timeline-caption metric-surface"><span class="chart-label"></span><span class="chart-scale"></span></div><canvas class="timeline" tabindex="0" role="img" aria-label="Selected receiver timeline"></canvas>
      <details class="context-details metric-surface"><summary>Nearest coverage & player context</summary><div class="nearest-context"></div></details><div class="lane-context metric-surface hidden"></div><p class="window-scope metric-surface"></p><div class="stat-row metric-surface"><div><div class="stat-value current-sep"></div><div class="stat-name">Separation now</div></div><div><div class="stat-value longest-window"></div><div class="stat-name">Longest eligible window</div></div><div><div class="stat-value total-window"></div><div class="stat-name">Total eligible window time</div></div></div><details class="context-details"><summary>Play context & source quality</summary><div class="source-context"></div><div class="quality-context future-content"></div><div class="play-description future-content">${esc(play.description || '')}</div></details></div></div></section>`;
  }

  function rebuildBoards() {
    $('#boards').classList.toggle('comparing', !!state.b);
    $('#boards').innerHTML = currentKeys().map(boardHTML).join('');
    state.boards = {};
    for (const element of $$('[data-board]')) {
      const key = element.dataset.board;
      state.boards[key] = { el: element, canvas: $('.field-canvas', element), timeline: $('.timeline', element), hitTargets: [], transform: null };
      $(`#receiver-${key}`).addEventListener('change', event => chooseReceiver(key, event.target.value));
      $(`#pair-${key}`).addEventListener('change', event => chooseReceiver(key, event.target.value, true));
      $(`#focus-${key}`).addEventListener('change', event => { state.focusPlayers[key] = event.target.value; render(); notify('focus'); });
      $$('[data-chart]', element).forEach(button => button.addEventListener('click', () => { state.ui.chart = button.dataset.chart; render(); notify('chart'); }));
      $('[data-expand]', element).addEventListener('click', expandField);
      bindField(key);
      bindTimeline(key);
    }
    populateComparison(); syncBoardControls();
  }

  function syncBoardControls() {
    for (const key of currentKeys()) {
      if ($(`#receiver-${key}`)) $(`#receiver-${key}`).value = state.receivers[key] || '';
      if ($(`#focus-${key}`)) $(`#focus-${key}`).value = state.focusPlayers[key] || '';
      if ($(`#pair-${key}`)) $(`#pair-${key}`).value = state.pairReceivers[key] || '';
    }
  }

  function syncControls() {
    $('#roleScope').value = state.metricOptions.scope;
    $('#lookback').value = String(state.metricOptions.lookback).replace(/^0\./, '.');
    $('#threshold').value = state.threshold;
    $('#thresholdValue').textContent = `${fmt(state.threshold)} yd`;
    $('#regionThreshold').textContent = `${fmt(state.threshold)} yd`;
    $('#downfieldOnly').checked = state.downfieldOnly;
    $('#inBoundsOnly').checked = state.metricOptions.inBoundsOnly;
    $('#minDuration').value = String(state.metricOptions.minDuration).replace(/^0\./, '.');
    $('#statsMode').value = state.ui.blind ? 'sofar' : state.ui.statsMode;
    $('#statsMode').disabled = state.ui.blind;
    $('#studyBoard').value = studyKey();
    $('#alignment').value = state.alignment;
    $('#manualAlignment').classList.toggle('hidden', state.alignment !== 'manual');
    $('#manualAnchorA').value = fmt(state.manualAnchors.a);
    $('#manualAnchorB').value = fmt(state.manualAnchors.b);
    for (const element of $$('#alignment option')) element.disabled = state.ui.blind && ['release', 'firstWindow', 'firstDownfield'].includes(element.value);
    for (const id of ['filterQuality', 'filterPenalty', 'sortPlays', 'jumpRelease']) $(`#${id}`).disabled = state.ui.blind;
    $('#heatMask').value = state.layers.mask;
    $('#inspectBoard option[value="b"]').disabled = !state.b;
    $('#speed').value = String(state.speed).replace(/^0\./, '.');
    $('#loopButton').setAttribute('aria-pressed', String(state.loop.enabled));
    $('#loopControls').classList.toggle('hidden', !state.loop.enabled);
    $('#loopStart').value = fmt(state.loop.start); $('#loopEnd').value = fmt(state.loop.end);
    $('#heatOpacity').value = state.layers.opacity; $('#trailLength').value = state.layers.trail; $('#labelMode').value = state.layers.labels;
    $('#shapeMarkers').checked = state.layers.shapes;
    for (const id of ['largeText', 'highContrast', 'reducedMotion']) $(`#${id}`).checked = state.ui[id];
    $('#fieldZoom').value = String(state.ui.zoom);
    $$('[data-layer]').forEach(input => { input.checked = !!state.layers[input.dataset.layer]; });
    $$('[data-mode]').forEach(button => { const active = button.dataset.mode === state.mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    for (const [flag, className] of [['blind', 'blind'], ['baseline', 'baseline'], ['largeText', 'large-text'], ['highContrast', 'high-contrast'], ['expanded', 'field-expanded'], ['libraryCollapsed', 'library-collapsed']]) document.body.classList.toggle(className, !!state.ui[flag]);
    const alignmentNames = { release: 'observed endpoints', firstWindow: 'first eligible windows', firstDownfield: 'first downfield arrival', manual: 'chosen times' };
    $('#clockDescription').textContent = state.alignment === 'snap' || !state.b ? 'Seconds after snap · same clock and scales' : `Aligned at ${alignmentNames[state.alignment]} (A +${fmt(anchor('a'))} / B +${fmt(anchor('b'))} s) · missing events use snap`;
    $('#preSnapControls').classList.toggle('hidden', !state.preSnap);
    if (state.preSnap) {
      const preview = getPlay(state.preSnap.key).preSnap;
      $('#preSnapSlider').max = preview.times.length - 1; $('#preSnapSlider').value = state.preSnap.index;
      $('#preSnapStatus').textContent = `${fmt(observedTime(state.preSnap.key))} s before snap. Analytical summaries are paused.`;
    }
    populateComparison(); syncBoardControls();
  }

  function setupStories() {
    const stories = (data.stories || []).filter(story => byId(story.id));
    $('#storyBar').classList.toggle('hidden', !stories.length);
    $('#storySelect').innerHTML = '<option value="">Choose a coaching example…</option>' + stories.map((story, index) => `<option value="${index}">${esc(story.title)}</option>`).join('');
    state.stories = stories;
  }

  function applyStory(index, compare = false) {
    const story = state.stories[index];
    if (!story) return;
    state.b = null; selectPlay('a', story.id);
    state.receivers.a = String(story.receiverId || defaultReceiver(getPlay('a'))); state.focusPlayers.a = state.receivers.a;
    if (compare && byId(story.compareId)) {
      state.b = String(story.compareId); state.receivers.b = String(story.compareReceiverId || defaultReceiver(getPlay('b'))); state.focusPlayers.b = state.receivers.b;
    }
    state.alignment = 'snap'; state.metricOptions = { ...state.metricOptions, threshold: 3, lookback: .5, downfieldOnly: true };
    state.t = clamp(Number(story.focusTime) || 0, 0, duration());
    state.storyIndex = index;
    $('#storySelect').value = String(index); $('#storyCaption').textContent = story.caption || '';
    $('#storyCompare').classList.toggle('hidden', !story.compareId);
    rebuildBoards(); syncControls(); setTab('replay'); render(); notify('story');
  }

  function canvasContext(canvas, settings = {}) {
    const rectangle = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(settings.width || rectangle.width));
    const height = Math.max(1, Math.round(settings.height || rectangle.height));
    const dpi = settings.exporting ? 1 : Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * dpi) || canvas.height !== Math.round(height * dpi)) {
      canvas.width = Math.round(width * dpi); canvas.height = Math.round(height * dpi);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpi, 0, 0, dpi, 0, 0); ctx.clearRect(0, 0, width, height);
    return { ctx, width, height, dpi };
  }

  function viewBounds(play, key) {
    const selected = currentKeys().map(getPlay);
    let left = state.ui.blind ? -15 : Math.min(-10, ...selected.map(p => Math.floor(Number(p.bounds?.xMin ?? p.los - 15) / 5) * 5 - p.los));
    let right = state.ui.blind ? 45 : Math.max(30, ...selected.map(p => Math.ceil(Number(p.bounds?.xMax ?? p.los + 40) / 5) * 5 - p.los));
    if (right - left < 55) right = left + 55;
    const fullSpan = Math.min(120, right - left), zoom = clamp(Number(state.ui.zoom) || 1, 1, 2);
    const span = fullSpan / zoom, ySpan = 53.3 / zoom;
    const selectedPlayer = playerById(play, state.focusPlayers[key]) || playerById(play, state.receivers[key]);
    const pos = selectedPlayer?.track[frame(key)];
    const xMid = zoom > 1 && pos ? pos[0] : play.los + (left + right) / 2;
    const yMid = zoom > 1 && pos ? pos[1] : 26.65;
    const xMin = clamp(xMid - span / 2, 0, 120 - span), yMin = clamp(yMid - ySpan / 2, 0, 53.3 - ySpan);
    return { xMin, xMax: xMin + span, yMin, yMax: yMin + ySpan };
  }

  function interpolate(colors, value) {
    const t = clamp(value, 0, 1) * (colors.length - 1), index = Math.min(colors.length - 2, Math.floor(t)), weight = t - index;
    return colors[index].map((channel, j) => Math.round(channel + (colors[index + 1][j] - channel) * weight));
  }

  const colors = {
    distance: [[17, 59, 70], [38, 138, 145], [131, 201, 172], [239, 222, 160]],
    change: [[71, 141, 208], [27, 62, 64], [238, 162, 90]]
  };

  function heatLayer(play, at, bounds) {
    const region = state.region && String(getPlay(state.region.key)?.id) === String(play.id) ? state.region : null;
    const key = `${play.id}:${at}:${state.mode}:${optionKey()}:${state.layers.mask}:${JSON.stringify(region)}:${JSON.stringify(bounds)}`;
    if (heatCache.has(key)) return heatCache.get(key);
    const elapsed = Number(play.times[at]) - Number(play.times[0]);
    if (state.mode === 'change' && elapsed + 1e-7 < state.metricOptions.lookback) return null;
    const defenders = M.defenders(play, state.metricOptions.scope);
    if (!defenders.length) return null;
    const nx = Math.max(1, Math.ceil(bounds.xMax - bounds.xMin)), ny = Math.max(1, Math.ceil(bounds.yMax - bounds.yMin));
    const canvas = document.createElement('canvas'); canvas.width = nx; canvas.height = ny;
    const ctx = canvas.getContext('2d'), image = ctx.createImageData(nx, ny), distances = new Float32Array(nx * ny);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const point = { x: bounds.xMin + (x + .5) * (bounds.xMax - bounds.xMin) / nx, y: bounds.yMax - (y + .5) * (bounds.yMax - bounds.yMin) / ny };
      const visible = state.layers.mask === 'downfield' ? point.x >= play.los : state.layers.mask === 'routes' ? routes(play).some(player => player.track[at] && Math.hypot(point.x - player.track[at][0], point.y - player.track[at][1]) <= 8) : state.layers.mask === 'region' ? region && point.x >= region.xMin && point.x <= region.xMax && point.y >= region.yMin && point.y <= region.yMax : true;
      if (!visible) { distances[y * nx + x] = NaN; continue; }
      const value = M.inspectPoint(play, point, at, options());
      distances[y * nx + x] = finite(value.distance) ? value.distance : NaN;
      const amount = state.mode === 'change' ? (Number(value.change) + 4) / 8 : Number(value.distance) / 8;
      const rgb = interpolate(colors[state.mode === 'change' ? 'change' : 'distance'], amount);
      const index = (y * nx + x) * 4;
      image.data[index] = rgb[0]; image.data[index + 1] = rgb[1]; image.data[index + 2] = rgb[2]; image.data[index + 3] = finite(value.distance) && (state.mode !== 'change' || finite(value.change)) ? 255 : 0;
    }
    ctx.putImageData(image, 0, 0);
    const value = { canvas, nx, ny, distances };
    heatCache.set(key, value);
    if (heatCache.size > 90) heatCache.delete(heatCache.keys().next().value);
    return value;
  }

  function renderField(key, canvas, settings = {}) {
    const play = getPlay(key), board = state.boards[key];
    if (!play || !canvas) return null;
    const { ctx, width, height } = canvasContext(canvas, settings), at = frame(key), observed = Number(play.times[at]);
    const topReserve = settings.exporting ? 39 : 18, bottomReserve = settings.exporting ? 108 : 25;
    const bounds = viewBounds(play, key), scale = Math.min((width - 46) / (bounds.xMax - bounds.xMin), (height - topReserve - bottomReserve) / (bounds.yMax - bounds.yMin));
    const fw = (bounds.xMax - bounds.xMin) * scale, fh = (bounds.yMax - bounds.yMin) * scale, ox = (width - fw) / 2, oy = topReserve + (height - topReserve - bottomReserve - fh) / 2;
    const X = x => ox + (x - bounds.xMin) * scale, Y = y => oy + (bounds.yMax - y) * scale;
    const invert = (x, y) => ({ x: bounds.xMin + (x - ox) / scale, y: bounds.yMax - (y - oy) / scale });
    const transform = { X, Y, invert, inverse: invert, bounds, ox, oy, fw, fh, scale, width, height };
    if (!settings.exporting && board) { board.transform = transform; board.hitTargets = []; }
    const preSnap = state.preSnap?.key === key && play.preSnap?.times?.length ? state.preSnap : null;
    const prePlayers = preSnap ? new Map(play.preSnap.players.map(player => [String(player.id), player])) : null;
    const position = player => preSnap ? prePlayers.get(String(player.id))?.track[preSnap.index] : player.track[at];
    const showMetrics = !state.ui.baseline && !preSnap;
    const heat = showMetrics && state.layers.heat && state.mode !== 'none' ? heatLayer(play, at, bounds) : null;
    ctx.fillStyle = '#102c2d'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#173d3b'; ctx.fillRect(ox, oy, fw, fh);
    ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, fw, fh); ctx.clip();
    if (heat) { ctx.globalAlpha = state.layers.opacity; ctx.imageSmoothingEnabled = false; ctx.drawImage(heat.canvas, ox, oy, fw, fh); ctx.globalAlpha = 1; }
    for (let x = Math.ceil(bounds.xMin / 5) * 5; x <= bounds.xMax; x += 5) {
      ctx.strokeStyle = x % 10 === 0 ? '#edf3dd55' : '#edf3dd28'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X(x), oy); ctx.lineTo(X(x), oy + fh); ctx.stroke();
      if (x > 10 && x < 110 && x % 10 === 0) {
        const number = x <= 60 ? x - 10 : 110 - x;
        ctx.fillStyle = '#eef4dfb0'; ctx.font = '600 12px system-ui'; ctx.textAlign = 'center';
        if (8 >= bounds.yMin && 8 <= bounds.yMax) ctx.fillText(number, X(x), Y(8));
        if (45.3 >= bounds.yMin && 45.3 <= bounds.yMax) ctx.fillText(number, X(x), Y(45.3));
      }
    }
    for (let x = Math.ceil(bounds.xMin); x <= bounds.xMax; x++) for (const y of [23.58, 29.75]) {
      ctx.strokeStyle = '#e8f0d54a'; ctx.lineWidth = .7; ctx.beginPath(); ctx.moveTo(X(x), Y(y - .35)); ctx.lineTo(X(x), Y(y + .35)); ctx.stroke();
    }
    for (const [value, color, dashed] of [[play.los, '#f5f7e8bb', true], [play.firstDown, '#f6d179bb', false]]) {
      if (!finite(value)) continue;
      ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.beginPath(); ctx.moveTo(X(value), oy); ctx.lineTo(X(value), oy + fh); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (heat && state.layers.contours) {
      ctx.strokeStyle = '#faf6cfbb'; ctx.lineWidth = .9; ctx.beginPath();
      for (let y = 0; y < heat.ny; y++) for (let x = 0; x < heat.nx; x++) {
        if (!Number.isFinite(heat.distances[y * heat.nx + x])) continue;
        const open = heat.distances[y * heat.nx + x] >= state.threshold;
        if (x + 1 < heat.nx && Number.isFinite(heat.distances[y * heat.nx + x + 1]) && open !== (heat.distances[y * heat.nx + x + 1] >= state.threshold)) {
          ctx.moveTo(ox + (x + 1) / heat.nx * fw, oy + y / heat.ny * fh); ctx.lineTo(ox + (x + 1) / heat.nx * fw, oy + (y + 1) / heat.ny * fh);
        }
        if (y + 1 < heat.ny && Number.isFinite(heat.distances[(y + 1) * heat.nx + x]) && open !== (heat.distances[(y + 1) * heat.nx + x] >= state.threshold)) {
          ctx.moveTo(ox + x / heat.nx * fw, oy + (y + 1) / heat.ny * fh); ctx.lineTo(ox + (x + 1) / heat.nx * fw, oy + (y + 1) / heat.ny * fh);
        }
      }
      ctx.stroke();
    }
    const selected = String(state.receivers[key]), paired = String(state.pairReceivers[key]), focus = String(state.focusPlayers[key]);
    if (showMetrics && state.layers.lane) {
      const lane = passingLane(key);
      if (lane.valid) {
        const [qx, qy] = lane.start, [rx, ry] = lane.end;
        ctx.strokeStyle = '#dfc6f599'; ctx.lineWidth = scale * 2; ctx.beginPath(); ctx.moveTo(X(qx), Y(qy)); ctx.lineTo(X(rx), Y(ry)); ctx.stroke();
        ctx.strokeStyle = '#f2defeff'; ctx.lineWidth = 1; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
        for (const defender of lane.inCorridor) {
          const p = defender.position; ctx.strokeStyle = '#ffc38a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 12, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }
    if (showMetrics && state.layers.ghosts && observed >= state.metricOptions.lookback) {
      const previous = frameAt(play, observed - state.metricOptions.lookback);
      for (const defender of M.defenders(play, state.metricOptions.scope)) {
        const old = defender.track[previous], now = defender.track[at]; if (!old || !now) continue;
        ctx.strokeStyle = '#e6f0d65c'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(X(old[0]), Y(old[1])); ctx.lineTo(X(now[0]), Y(now[1])); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(X(old[0]), Y(old[1]), 5, 0, Math.PI * 2); ctx.strokeStyle = '#e5efd982'; ctx.stroke();
      }
    }
    if (!preSnap && state.layers.trail !== 'none') {
      const trailStart = ['full', 'whole'].includes(state.layers.trail) ? 0 : frameAt(play, observed - Number(state.layers.trail));
      const trailEnd = state.layers.trail === 'whole' && !state.ui.blind ? play.times.length - 1 : at;
      for (const player of play.players) {
        if (player.side === 'ball' || !['route', 'coverage'].includes(player.role) && String(player.id) !== focus) continue;
        ctx.beginPath(); let begun = false;
        for (let i = trailStart; i <= trailEnd; i++) {
          const pos = player.track[i]; if (!pos) continue;
          if (!begun) { ctx.moveTo(X(pos[0]), Y(pos[1])); begun = true; } else ctx.lineTo(X(pos[0]), Y(pos[1]));
        }
        ctx.strokeStyle = String(player.id) === selected ? '#ffd18ddd' : String(player.id) === paired ? '#d4b4f5dd' : player.side === 'offense' ? '#efa16366' : '#9bd9f267';
        ctx.lineWidth = String(player.id) === selected || String(player.id) === paired ? 2.8 : 1.2; ctx.stroke();
      }
    }
    if (showMetrics && state.layers.links) {
      for (const id of [selected, paired]) {
        const receiver = playerById(play, id); if (!receiver) continue;
        const nearest = M.nearest(play, id, at, options()), defender = playerById(play, nearest.nearestId);
        if (!defender?.track[at] || !receiver.track[at]) continue;
        ctx.strokeStyle = id === paired ? '#d8b9f2bb' : '#fff3c8b8'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(X(receiver.track[at][0]), Y(receiver.track[at][1])); ctx.lineTo(X(defender.track[at][0]), Y(defender.track[at][1])); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    const ordered = [...play.players].sort((a, b) => Number(String(a.id) === focus) - Number(String(b.id) === focus));
    for (const player of ordered) {
      if (!state.layers.rushers && player.role === 'rush' || !state.layers.blockers && player.role === 'block') continue;
      const pos = position(player); if (!pos || !finite(pos[0]) || !finite(pos[1])) continue;
      const x = X(pos[0]), y = Y(pos[1]), ball = player.side === 'ball', id = String(player.id), chosen = id === selected || id === paired || id === focus;
      const radius = ball ? 3.5 : state.ui.largeText ? 9 : 7.5;
      const color = id === paired ? '#c8a5e4' : player.side === 'offense' ? '#efa063' : player.side === 'defense' ? '#81ccef' : '#fff3d3';
      if (state.layers.arrows && !ball && Number(pos[2]) > .5 && finite(pos[3])) {
        const angle = pos[3] * Math.PI / 180, dx = Math.sin(angle), dy = -Math.cos(angle), length = radius + 9;
        ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x + dx * radius, y + dy * radius); ctx.lineTo(x + dx * length, y + dy * length); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x + dx * (length - 3) - dy * 2, y + dy * (length - 3) + dx * 2); ctx.lineTo(x + dx * length, y + dy * length); ctx.lineTo(x + dx * (length - 3) + dy * 2, y + dy * (length - 3) - dx * 2); ctx.stroke();
      }
      if (chosen) { ctx.beginPath(); ctx.arc(x, y, radius + 4, 0, Math.PI * 2); ctx.strokeStyle = id === paired ? '#e0c3fa' : '#ffe4b5'; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.beginPath();
      if (ball) ctx.ellipse(x, y, 4.5, 3, -.5, 0, Math.PI * 2);
      else if (state.layers.shapes && player.side === 'defense') { ctx.moveTo(x, y - radius - 1); ctx.lineTo(x + radius + 1, y); ctx.lineTo(x, y + radius + 1); ctx.lineTo(x - radius - 1, y); ctx.closePath(); }
      else ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = player.role === 'coverage' ? '#e8f8fa' : '#173334'; ctx.lineWidth = player.role === 'coverage' ? 1.5 : 1.2; ctx.stroke();
      if (!ball && state.layers.labels !== 'none') {
        ctx.font = `750 ${state.ui.largeText ? 10 : 9}px system-ui`; ctx.fillStyle = '#163a3a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(player.jersey || '', x, y + .3); ctx.textBaseline = 'alphabetic';
      }
      if (!settings.exporting && board) board.hitTargets.push({ id: player.id, x, y, radius: 16, player });
      if (chosen || state.layers.labels === 'name') {
        const label = (player.name || '').split(' ').slice(-1)[0]; ctx.font = '600 10px system-ui'; ctx.textAlign = 'center';
        const tw = ctx.measureText(label).width, lx = clamp(x, ox + tw / 2 + 5, ox + fw - tw / 2 - 5), ly = Math.max(oy + 13, y - radius - 10);
        ctx.fillStyle = '#0b292af0'; ctx.fillRect(lx - tw / 2 - 4, ly - 10, tw + 8, 15); ctx.fillStyle = chosen ? '#ffe0a7' : '#dbe9dd'; ctx.fillText(label, lx, ly + 1);
      }
    }
    if (state.region?.key === key) {
      const region = state.region;
      ctx.fillStyle = '#fff0a71a'; ctx.strokeStyle = '#f6dfa6'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
      ctx.fillRect(X(region.xMin), Y(region.yMax), (region.xMax - region.xMin) * scale, (region.yMax - region.yMin) * scale);
      ctx.strokeRect(X(region.xMin), Y(region.yMax), (region.xMax - region.xMin) * scale, (region.yMax - region.yMin) * scale); ctx.setLineDash([]);
    }
    if (state.point?.key === key) {
      const x = X(state.point.x), y = Y(state.point.y); ctx.strokeStyle = '#ffe3a1'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y); ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8); ctx.stroke();
    }
    document.dispatchEvent(new CustomEvent('openfield:draw', { detail: { key, ctx, transform, frame: at, play, observedTime: preSnap ? play.preSnap.times[preSnap.index] : observed, exporting: !!settings.exporting, preSnap: !!preSnap } }));
    ctx.restore(); ctx.strokeStyle = '#d4e6d39a'; ctx.lineWidth = 1; ctx.strokeRect(ox, oy, fw, fh);
    ctx.fillStyle = '#b4ccbd'; ctx.font = '10px system-ui'; ctx.textAlign = 'left';
    ctx.fillText('LOS', clamp(X(play.los) + 4, ox, ox + fw - 25), oy + fh + 15); ctx.textAlign = 'right'; ctx.fillText('Observed positions · ≈1 yd grid', ox + fw, oy + fh + 15);
    const noHistory = state.mode === 'change' && observed + 1e-7 < state.metricOptions.lookback;
    const unavailable = showMetrics && state.layers.heat && state.mode !== 'none' && !heat;
    if (settings.exporting && unavailable) {
      ctx.fillStyle = '#102c2dee'; ctx.fillRect(width / 2 - 165, height / 2 - 32, 330, 64); ctx.fillStyle = '#f1edcf'; ctx.font = '600 13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(noHistory ? `Need ${fmt(state.metricOptions.lookback)} s of observed history` : 'Map unavailable for this frame', width / 2, height / 2 + 4);
    }
    if (settings.exporting) {
      const ended = rawTime(key) > endTime(play) + .025, notStarted = rawTime(key) < -1e-6;
      const actual = preSnap ? play.preSnap.times[preSnap.index] : observed;
      const phase = preSnap ? 'PRE-SNAP · metrics paused' : notStarted ? 'NOT STARTED on aligned clock' : ended ? `ENDED · ${play.endpointLabel}` : rawTime(key) >= endTime(play) - .0001 && !state.ui.blind ? play.endpointLabel : 'after snap';
      ctx.textAlign = 'left'; ctx.fillStyle = '#edf2dc'; ctx.font = '650 15px system-ui';
      ctx.fillText(`PLAY ${key.toUpperCase()}  ${actual >= 0 ? '+' : ''}${fmt(actual)} s  ·  ${phase}`, 24, 25);
      ctx.textAlign = 'right'; ctx.font = '600 12px system-ui'; ctx.fillText(`${play.offense} OFFENSE →`, width - 24, 25);
      const legendWidth = Math.min(440, width - 72), lx = (width - legendWidth) / 2, ly = height - 66;
      if (showMetrics && state.layers.heat && state.mode !== 'none') {
        const gradient = ctx.createLinearGradient(lx, 0, lx + legendWidth, 0);
        const palette = colors[state.mode === 'change' ? 'change' : 'distance'];
        palette.forEach((rgb, index) => gradient.addColorStop(index / (palette.length - 1), `rgb(${rgb.map((v, channel) => Math.round(v * state.layers.opacity + [23, 61, 59][channel] * (1 - state.layers.opacity))).join(',')})`));
        ctx.fillStyle = gradient; ctx.fillRect(lx, ly, legendWidth, 11);
        const ticks = state.mode === 'change' ? ['−4', '−2', '0', '+2', '+4 yd'] : ['0', '2', '4', '6', '8+ yd'];
        ctx.fillStyle = '#d9e8d5'; ctx.font = '11px system-ui';
        ticks.forEach((tick, index) => { ctx.textAlign = index === 0 ? 'left' : index === 4 ? 'right' : 'center'; ctx.fillText(tick, lx + index / 4 * legendWidth, ly + 25); });
        ctx.textAlign = 'center'; ctx.fillText(state.mode === 'change' ? `Closing ← fixed-location change over ${fmt(state.metricOptions.lookback)} s → Opening` : 'Closer ← nearest-defender distance → Farther', width / 2, ly - 8);
      } else { ctx.fillStyle = '#d9e8d5'; ctx.textAlign = 'center'; ctx.font = '12px system-ui'; ctx.fillText('Tracking view · no heatmap displayed', width / 2, ly + 11); }
      const scope = `${M.defenders(play, state.metricOptions.scope).length} ${state.metricOptions.scope === 'all' ? 'defenders' : 'coverage-role defenders'}`;
      ctx.textAlign = 'center'; ctx.font = '11px system-ui'; ctx.fillStyle = '#c4dbc8';
      ctx.fillText(`● Offense   ◇ Defense   ○ Prior defender position   ·   ${scope}   ·   mask: ${state.layers.mask || 'all'}`, width / 2, height - 14);
    }
    if (!settings.exporting && board) {
      const ended = rawTime(key) > endTime(play) + .025, notStarted = rawTime(key) < -1e-6;
      const actual = preSnap ? play.preSnap.times[preSnap.index] : observed;
      $('.field-clock', board.el).innerHTML = `<strong>${actual >= 0 ? '+' : ''}${fmt(actual)} s</strong> ${preSnap ? '<span class="ended-flag">PRE-SNAP · metrics paused</span>' : notStarted ? '<span class="ended-flag">NOT STARTED on aligned clock</span>' : ended ? `<span class="ended-flag">ENDED · ${esc(play.endpointLabel)}</span>` : rawTime(key) >= endTime(play) - .0001 ? `<span class="ended-flag">${esc(play.endpointLabel)}</span>` : 'after snap'}`;
      const note = $('.history-note', board.el); note.classList.toggle('hidden', !unavailable); note.textContent = noHistory ? `${fmt(state.metricOptions.lookback)} seconds of history needed. Advance the replay.` : 'No eligible defender positions for this map.';
      $('.scope-label', board.el).textContent = `${M.defenders(play, state.metricOptions.scope).length} ${state.metricOptions.scope === 'all' ? 'defenders' : 'coverage-role defenders'}`;
      const gradientColors = colors[state.mode === 'change' ? 'change' : 'distance'].map(rgb => `rgb(${rgb.map((v, index) => Math.round(v * state.layers.opacity + [23, 61, 59][index] * (1 - state.layers.opacity))).join(',')})`);
      $('.gradient', board.el).style.background = `linear-gradient(90deg,${gradientColors.join(',')})`;
      $('.heat-ticks', board.el).innerHTML = (state.mode === 'change' ? ['−4', '−2', '0', '+2', '+4 yd'] : ['0', '2', '4', '6', '8+ yd']).map(value => `<span>${value}</span>`).join('');
      $('.legend-low', board.el).textContent = state.mode === 'change' ? 'Closing' : 'Closer'; $('.legend-high', board.el).textContent = state.mode === 'change' ? 'Opening' : 'Farther';
      $('.heat-key', board.el).classList.toggle('hidden', !showMetrics || !state.layers.heat || state.mode === 'none');
      canvas.setAttribute('aria-label', `${play.offense} versus ${play.defense}, ${fmt(actual)} seconds from snap. ${state.metricOptions.scope === 'all' ? 'All defenders' : 'Coverage defenders'} in metric scope. ${ended ? 'Observed tracking has ended.' : ''} Select any player using the adjacent menu, or inspect receiver values in the Routes table.`);
    }
    return { transform, frame: at, play, observedTime: observed, heatAvailable: !!heat, noHistory };
  }

  function passingLane(key) {
    const play = getPlay(key), at = frame(key), receiver = playerById(play, state.receivers[key]);
    const quarterback = play.players.find(player => player.role === 'pass') || play.players.find(player => player.position === 'QB' && player.side === 'offense');
    const start = quarterback?.track[at], end = receiver?.track[at];
    if (!start || !end) return { valid: false, reason: 'Passer or receiver position unavailable.' };
    const dx = end[0] - start[0], dy = end[1] - start[1], length = Math.hypot(dx, dy);
    if (length < .01) return { valid: false, reason: 'Passer and receiver occupy the same point.' };
    const candidates = M.defenders(play, 'all').flatMap(player => {
      const p = player.track[at]; if (!p) return [];
      const projection = ((p[0] - start[0]) * dx + (p[1] - start[1]) * dy) / (length * length);
      if (projection <= 0 || projection >= 1) return [];
      return [{ id: player.id, name: player.name, position: p, projection, distance: Math.abs(dx * (p[1] - start[1]) - dy * (p[0] - start[0])) / length }];
    }).sort((a, b) => a.distance - b.distance);
    return { valid: true, start, end, length, candidates, nearest: candidates[0] || null, inCorridor: candidates.filter(player => player.distance <= 1) };
  }

  function drawField(key, settings = {}) {
    return renderField(key, settings.canvas || state.boards[key]?.canvas, settings);
  }

  function bindField(key) {
    const board = state.boards[key], canvas = board.canvas; let start = null;
    const pointFromEvent = event => {
      const rect = canvas.getBoundingClientRect(), point = board.transform?.invert(event.clientX - rect.left, event.clientY - rect.top);
      if (!point) return null;
      return { x: clamp(point.x, 0, 120), y: clamp(point.y, 0, 53.3), key };
    };
    canvas.addEventListener('pointerdown', event => {
      if (event.defaultPrevented) return;
      const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      const hit = board.hitTargets.map(item => ({ ...item, distance: Math.hypot(item.x - x, item.y - y) })).filter(item => item.distance < item.radius).sort((a, b) => a.distance - b.distance)[0];
      if (hit) {
        state.focusPlayers[key] = String(hit.id);
        if (hit.player.role === 'route') chooseReceiver(key, hit.id, event.shiftKey);
        else { syncBoardControls(); render(); notify('focus'); }
        return;
      }
      start = pointFromEvent(event); if (start) canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
      if (event.defaultPrevented) return;
      const point = pointFromEvent(event); if (!point) return;
      if (start) {
        state.region = { key, xMin: Math.min(start.x, point.x), xMax: Math.max(start.x, point.x), yMin: Math.min(start.y, point.y), yMax: Math.max(start.y, point.y) };
        render(false); return;
      }
      if (state.ui.baseline) return;
      const value = M.inspectPoint(getPlay(key), point, frame(key), options());
      const tooltip = $('#fieldTooltip'); tooltip.classList.remove('hidden');
      tooltip.innerHTML = `<strong>${fmt(value.distance)} yd</strong> to ${esc(name(getPlay(key), value.nearestId))}<br>${signed(value.change)} yd over ${fmt(state.metricOptions.lookback)} s · x ${fmt(point.x)}, y ${fmt(point.y)}`;
      tooltip.style.left = `${Math.min(window.innerWidth - 260, event.clientX + 15)}px`; tooltip.style.top = `${Math.max(8, event.clientY - 70)}px`;
      if (!state.point) updatePointInspector(point);
    });
    canvas.addEventListener('pointerup', event => {
      if (!start || event.defaultPrevented) { start = null; return; }
      const point = pointFromEvent(event); if (!point) { start = null; return; }
      if (Math.hypot(point.x - start.x, point.y - start.y) < .8) { state.point = point; state.region = null; updatePointInspector(point); }
      else { state.point = null; $('#regionResults').innerHTML = '<p class="empty-inline">Region selected. Calculate openings and receiver arrivals with the button above.</p>'; }
      start = null; render(); notify('inspection');
    });
    canvas.addEventListener('pointercancel', () => { start = null; });
    canvas.addEventListener('pointerleave', () => $('#fieldTooltip').classList.add('hidden'));
  }

  function updatePointInspector(point = state.point) {
    if (!point) { $('#pointInspector').innerHTML = '<p class="empty-inline">Move over the field to inspect exact spacing. Click a point to hold it, or drag a region to study openings and arrivals.</p>'; return; }
    if (state.preSnap?.key === point.key) { $('#pointInspector').innerHTML = '<p class="empty-inline">Point spacing is paused during the pre-snap preview.</p>'; return; }
    if (state.ui.baseline) return;
    const play = getPlay(point.key), value = M.inspectPoint(play, point, frame(point.key), options());
    $('#pointInspector').innerHTML = `<div class="point-values"><span><strong>${fmt(value.distance)} yd</strong>Nearest: ${esc(name(play, value.nearestId))}</span><span><strong>${signed(value.change)} yd</strong>Fixed-point change over ${fmt(state.metricOptions.lookback)} s</span><span><strong>${fmt(value.previousDistance)} yd</strong>Same location previously</span><span><strong>${value.within3 ?? '—'} / ${value.within5 ?? '—'}</strong>Defenders within 3 / 5 yd</span><span>x ${fmt(point.x)} · y ${fmt(point.y)}<br>${state.point ? 'Pinned' : 'Hover inspection'} · Play ${point.key.toUpperCase()}</span></div>`;
  }

  function recordAt(play, receiverId, index) {
    const record = series(play, receiverId)[index] || {};
    const nearest = M.nearest(play, receiverId, index, options());
    return { ...nearest, ...record, distance: finite(record.separationAfter) ? record.separationAfter : nearest.distance };
  }

  function drawTimeline(key) {
    const board = state.boards[key], play = getPlay(key), receiver = state.receivers[key];
    if (!board || !receiver) return;
    const { ctx, width, height } = canvasContext(board.timeline);
    const left = 36, right = width - 17, top = 14, bottom = height - 25, limit = chartDuration();
    const X = time => left + (time - offset(key)) / limit * (right - left);
    const isLift = state.ui.chart === 'lift', low = isLift ? -8 : 0, high = isLift ? 8 : 12;
    const Y = value => bottom - (clamp(value, low, high) - low) / (high - low) * (bottom - top);
    board.timelineTransform = { left, right, duration: limit };
    const stats = windows(play, receiver, statsThrough(key));
    ctx.fillStyle = '#e1eee0';
    if (!isLift) for (const interval of stats.intervals || []) ctx.fillRect(X(interval.start), top, Math.max(0, X(interval.end) - X(interval.start)), bottom - top);
    const startX = X(0), endX = X(endTime(play));
    ctx.fillStyle = '#f0f2ed'; if (startX > left) ctx.fillRect(left, top, startX - left, bottom - top);
    if (!state.ui.blind && endX < right) ctx.fillRect(endX, top, right - endX, bottom - top);
    ctx.font = `${state.ui.largeText ? 11 : 9}px system-ui`; ctx.textAlign = 'right';
    for (const value of isLift ? [-8, -4, 0, 4, 8] : [0, 4, 8, 12]) {
      ctx.strokeStyle = value === 0 && isLift ? '#a9beab' : '#e5ece1'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, Y(value)); ctx.lineTo(right, Y(value)); ctx.stroke();
      ctx.fillStyle = '#68816d'; ctx.fillText(value === high ? `${value}+` : value === low && low < 0 ? `${value}−` : value, left - 8, Y(value) + 3);
    }
    if (!isLift) {
      ctx.strokeStyle = '#b68747'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(left, Y(state.threshold)); ctx.lineTo(right, Y(state.threshold)); ctx.stroke(); ctx.setLineDash([]);
    }
    const last = state.ui.blind ? frame(key) : play.times.length - 1;
    const plot = (id, field, color) => {
      ctx.beginPath(); let begun = false;
      for (let index = 0; index <= last; index++) {
        const record = recordAt(play, id, index), value = record[field];
        if (!finite(value) || isLift && !record.valid) { begun = false; continue; }
        const x = X(Number(play.times[index])); if (x < left - 1 || x > right + 1) continue;
        if (!begun) { ctx.moveTo(x, Y(value)); begun = true; } else ctx.lineTo(x, Y(value));
      }
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    };
    if (isLift) { plot(receiver, 'coverage', '#26775b'); plot(receiver, 'receiver', '#d18343'); }
    else {
      plot(receiver, 'distance', '#26775b');
      if (state.ui.chart === 'pair' && state.pairReceivers[key]) plot(state.pairReceivers[key], 'distance', '#9266b5');
    }
    for (let index = 1; index <= last; index++) if (series(play, receiver)[index]?.nearestSwitch) {
      ctx.strokeStyle = '#b68a55'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X(play.times[index]), bottom - 4); ctx.lineTo(X(play.times[index]), bottom + 2); ctx.stroke();
    }
    ctx.fillStyle = '#718575'; ctx.textAlign = 'center';
    for (let time = 0; time <= limit + .001; time += limit > 5 || width < 430 ? 1 : .5) {
      const x = left + time / limit * (right - left); ctx.fillText(time === 0 && state.alignment === 'snap' ? 'Snap' : `${fmt(time)}s`, x, height - 7);
    }
    if (!state.ui.blind) {
      ctx.strokeStyle = '#899b89'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(endX, top); ctx.lineTo(endX, bottom); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#63796a'; ctx.font = '9px system-ui'; ctx.textAlign = 'right'; ctx.fillText(play.endpointLabel || 'End', Math.min(right, endX - 3), 10);
    }
    const cursorX = left + state.t / limit * (right - left);
    ctx.strokeStyle = '#193c30'; ctx.beginPath(); ctx.moveTo(cursorX, top); ctx.lineTo(cursorX, bottom); ctx.stroke();
    const current = recordAt(play, receiver, frame(key)), value = isLift ? current.coverage : current.distance;
    if (finite(value)) { ctx.beginPath(); ctx.arc(X(play.times[frame(key)]), Y(value), 3.4, 0, Math.PI * 2); ctx.fillStyle = '#176d50'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.3; ctx.stroke(); }
    $('.chart-label', board.el).textContent = isLift ? 'Green: coverage · amber: receiver' : state.ui.chart === 'pair' ? 'Green: selected · purple: paired route' : 'Distance · short ticks: nearest-defender changes';
    $('.chart-scale', board.el).textContent = isLift ? '−8 to +8 yd' : '0–12+ yd';
    $$('[data-chart]', board.el).forEach(button => button.classList.toggle('active', button.dataset.chart === state.ui.chart));
    board.timeline.setAttribute('aria-label', `${name(play, receiver)}. Separation ${fmt(current.distance)} yards, Coverage Lift ${signed(current.coverage)} yards over ${fmt(state.metricOptions.lookback)} seconds. ${state.ui.blind ? 'Only observations through the current frame are shown.' : 'Observed receiver timeline; table available in Routes view.'}`);
  }

  function bindTimeline(key) {
    const board = state.boards[key], canvas = board.timeline; let dragging = false;
    const seekAt = event => {
      const box = canvas.getBoundingClientRect(), transform = board.timelineTransform; if (!transform) return;
      seek(clamp((event.clientX - box.left - transform.left) / (transform.right - transform.left) * transform.duration, 0, transform.duration));
    };
    canvas.addEventListener('pointerdown', event => { dragging = true; canvas.setPointerCapture(event.pointerId); seekAt(event); });
    canvas.addEventListener('pointermove', event => { if (dragging) seekAt(event); });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('pointercancel', () => { dragging = false; });
  }

  function renderBoardMetrics(key) {
    const board = state.boards[key], play = getPlay(key), at = frame(key), receiver = state.receivers[key];
    if (!receiver) return;
    renderPlayerContext(key);
    if (state.preSnap?.key === key || rawTime(key) < -1e-6) {
      $$('.lift-value, .current-sep, .longest-window, .total-window', board.el).forEach(element => { element.textContent = '—'; });
      $('.metric-equation', board.el).textContent = 'Analytical summaries paused. Return to the observed post-snap interval.';
      $('.nearest-context', board.el).textContent = '';
      $('.window-scope', board.el).textContent = 'Pre-snap positions are provided for context only.';
      $('.lane-context', board.el).classList.add('hidden');
      const { ctx, width, height } = canvasContext(board.timeline); ctx.fillStyle = '#59735d'; ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.fillText('Post-snap timeline paused', width / 2, height / 2); return;
    }
    const current = context(key), nearest = M.nearest(play, receiver, at, options()), stats = windows(play, receiver, statsThrough(key));
    const valid = current.valid && state.preSnap?.key !== key;
    for (const [selector, field] of [['.coverage-lift', 'coverage'], ['.receiver-lift', 'receiver'], ['.net-lift', 'gain']]) {
      const element = $(selector, board.el), value = valid ? current[field] : null;
      element.textContent = signed(value); element.className = `lift-value ${selector.slice(1)} ${!finite(value) ? 'unavailable' : value >= 0 ? 'positive' : 'negative'}`;
    }
    $('.metric-equation', board.el).textContent = valid ? `${fmt(current.separationBefore)} → ${fmt(current.separationAfter)} yd separation · ${fmt(current.elapsed)} s window. The signed components sum to ${signed(current.gain)} yd.` : current.reason || `A full ${fmt(state.metricOptions.lookback)} s of eligible observed history is needed.`;
    const leverage = nearest.leverage ? `${nearest.leverage.inside ? 'Inside (closer to field center)' : 'Outside (farther from field center)'} · ${signed(nearest.leverage.downfield)} yd downfield relative to receiver` : 'Leverage unavailable';
    $('.nearest-context', board.el).innerHTML = `<strong>${esc(name(play, nearest.nearestId))}</strong> · nearest ${fmt(nearest.distance)} yd<br>Second: ${esc(name(play, nearest.secondId))} · ${fmt(nearest.secondDistance)} yd<br>${nearest.within3 ?? '—'} within 3 yd · ${nearest.within5 ?? '—'} within 5 yd<br>Separation rate ${signed(nearest.separationRate)} yd/s (positive = widening)<br><span class="muted">${esc(leverage)}${current.nearestSwitch ? ' · Nearest defender changed' : ''}</span><br><span>First eligible opening: ${finite(stats.timeToFirst) ? `+${fmt(stats.timeToFirst)} s` : 'Not observed'} · ${fmt(stats.percentEligible)}% of ${fmt(stats.eligibleSeconds)} eligible seconds</span>${!state.ui.blind && finite(stats.releaseLead) ? `<br>First observed opening leads pass release by ${fmt(stats.releaseLead)} s` : ''}`;
    $('.current-sep', board.el).innerHTML = `${fmt(nearest.distance)} <small>yd</small>`;
    $('.longest-window', board.el).innerHTML = `${fmt(stats.longest)} <small>s</small>`;
    $('.total-window', board.el).innerHTML = `${fmt(stats.total)} <small>s</small>`;
    const censored = (stats.intervals || []).filter(interval => interval.leftCensored || interval.rightCensored);
    $('.window-scope', board.el).textContent = `${statsThrough(key) === undefined ? 'Whole observed play' : 'Observed so far'} · ≥${fmt(state.threshold)} yd for ≥${fmt(state.metricOptions.minDuration)} s${state.downfieldOnly ? ' · downfield' : ''}${state.metricOptions.inBoundsOnly ? ' · in bounds' : ''}. ${censored.length ? `${censored.length} boundary-censored window(s).` : ''}`;
    const lane = state.layers.lane ? passingLane(key) : null;
    $('.lane-context', board.el).classList.toggle('hidden', !state.layers.lane);
    $('.lane-context', board.el).innerHTML = lane?.valid ? `<strong>Exploratory passing lane</strong><br>${fmt(lane.length)} yd straight segment · ${lane.inCorridor.length} defenders within 1 yd on either side, between passer and receiver.${lane.nearest ? `<br>Closest along segment: ${esc(lane.nearest.name)} · ${fmt(lane.nearest.distance)} yd perpendicular distance.` : '<br>No defender projects between the endpoints.'}<p>All defenders; present positions only. This excludes ball flight, height, reach and reaction. It is not throw feasibility.</p>` : esc(lane?.reason || '');
    if (!state.ui.blind) {
      const outcomeContext = play.outcomeContext;
      $('.play-description', board.el).innerHTML = `${esc(play.description || '')}${outcomeContext?.targetName ? `<br><strong>Charted target:</strong> ${esc(outcomeContext.targetName)} · nflverse ${esc(outcomeContext.targetStatus || '')}` : ''}${finite(outcomeContext?.epa) ? ` · EPA ${fmt(outcomeContext.epa, 2)}` : ''}`;
    }
    drawTimeline(key);
  }

  function renderPlayerContext(key) {
    const board = state.boards[key], play = getPlay(key), focus = playerById(play, state.focusPlayers[key]);
    const preview = state.preSnap?.key === key ? play.preSnap.players.find(player => String(player.id) === String(focus?.id)) : null;
    const pos = preview ? preview.track[state.preSnap.index] : focus?.track[frame(key)];
    const protection = Object.entries(focus?.protection || {}).filter(([, value]) => value !== null && value !== '');
    $('.focus-player', board.el).innerHTML = focus && pos ? `<strong>${esc(focus.name)}</strong> · #${esc(focus.jersey)} · ${esc(focus.position || 'Position unknown')} · ${esc(focus.role)}<br>x ${fmt(pos[0])} · y ${fmt(pos[1])} yd · speed ${fmt(pos[2])} yd/s<br>Acceleration ${fmt(pos[5])} yd/s² · last-frame displacement ${fmt(pos[6], 2)} yd${focus.scoutingAvailable === false ? '<br>Scouting label unavailable' : ''}${protection.length && !state.ui.blind ? `<br>${protection.map(([field, value]) => `${esc(field)}: ${esc(value)}`).join(' · ')}` : ''}` : 'Select any player on the field or in the menu.';
    const source = play.context || {};
    $('.source-context', board.el).innerHTML = `<p>${esc(source.season || data.meta?.season || '')} · week ${esc(source.week ?? '—')} · ${esc(source.gameDate || '')}<br>Personnel: offense ${esc(source.personnelO || 'unknown')} · defense ${esc(source.personnelD || 'unknown')}<br>Defenders in box: ${esc(source.defendersInBox ?? '—')} · score ${esc(play.awayTeam)} ${esc(source.awayScore ?? '—')}–${esc(source.homeScore ?? '—')} ${esc(play.homeTeam)}${!state.ui.blind ? `<br>Play action: ${source.playAction === null || source.playAction === undefined ? 'unknown' : source.playAction ? 'yes' : 'no'} · dropback ${esc(source.dropbackType || 'unknown')}` : ''}</p>`;
    const quality = play.quality || {}, penalty = play.penalty || {};
    $('.quality-context', board.el).innerHTML = state.ui.blind ? '' : `<p><strong>Observation quality</strong><br>${qualityFlags(play).length ? qualityFlags(play).map(flag => esc(flag).replaceAll('_', ' ')).join(' · ') : 'No flagged source issues.'}<br>${(quality.scoutingMissingIds || []).length} missing scouting labels · ${(quality.unknownRoleIds || []).length} unknown roles · ${(quality.eventDisagreements || []).length} event disagreements · ${(quality.trajectoryFlags || []).length} trajectory flags<br>Field-boundary ambiguity: ${quality.fieldAmbiguity?.frameCount ?? 0} frame(s), ${quality.fieldAmbiguity?.routeIntervalCount ?? 0} route interval(s). Displayed in-bounds scope is geometric.</p>${penalty.hasPenalty ? `<p><strong>${penalty.nullified ? 'Nullified play' : 'Penalized play'}</strong> · ${esc(penalty.yards ?? 'unknown')} penalty yards<br>${(penalty.fouls || []).map(foul => `${esc(foul.name)}${foul.playerId ? ` (${esc(name(play, foul.playerId))})` : ''}`).join(' · ') || 'No structured foul name'}${penalty.nullified ? `<br>Nullification source: ${esc(penalty.nullifiedSource || 'source record')}` : ''}</p>` : ''}`;
  }

  function renderAllRoutes() {
    if (state.ui.tab !== 'routes' || state.ui.baseline) return;
    const key = studyKey(), play = getPlay(key), list = routes(play), canvas = $('#allRoutesTimeline');
    if (state.preSnap?.key === key) {
      $('#allRoutesTable').innerHTML = '<p class="notice">Post-snap analysis is paused during pre-snap preview. Return to snap to inspect distance windows.</p>';
      $('#eventList').innerHTML = ''; $('#fourDistances').innerHTML = ''; canvasContext(canvas); return;
    }
    canvas.style.height = `${Math.max(170, list.length * 46 + 36)}px`;
    const { ctx, width, height } = canvasContext(canvas), left = Math.min(150, width * .32), right = width - 20, limit = chartDuration();
    const X = time => left + (time - offset(key)) / limit * (right - left);
    ctx.font = '11px system-ui';
    for (let index = 0; index < list.length; index++) {
      const receiver = list[index], y = 18 + index * 46, stats = windows(play, receiver.id, statsThrough(key));
      ctx.fillStyle = '#f0f4eb'; ctx.fillRect(left, y, right - left, 28);
      ctx.fillStyle = String(receiver.id) === String(state.receivers[key]) ? '#244f3c' : '#4b6755'; ctx.textAlign = 'left';
      ctx.fillText(`#${receiver.jersey} ${(receiver.name || '').split(' ').slice(-1)[0]}`, 5, y + 19);
      ctx.fillStyle = '#a5c8a3'; for (const interval of stats.intervals || []) ctx.fillRect(X(interval.start), y, Math.max(0, X(interval.end) - X(interval.start)), 28);
      ctx.beginPath(); let begun = false;
      const last = state.ui.blind ? frame(key) : play.times.length - 1;
      for (let i = 0; i <= last; i++) {
        const record = recordAt(play, receiver.id, i); if (!finite(record.distance)) continue;
        const px = X(play.times[i]), py = y + 26 - clamp(record.distance, 0, 12) / 12 * 24;
        if (!begun) { ctx.moveTo(px, py); begun = true; } else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = '#28664c'; ctx.lineWidth = 1.4; ctx.stroke();
    }
    ctx.strokeStyle = '#223e31'; ctx.beginPath(); ctx.moveTo(left + state.t / limit * (right - left), 10); ctx.lineTo(left + state.t / limit * (right - left), height - 25); ctx.stroke();
    ctx.fillStyle = '#708171'; ctx.textAlign = 'center';
    for (let time = 0; time <= limit; time += limit > 5 ? 1 : .5) ctx.fillText(`${fmt(time)}s`, left + time / limit * (right - left), height - 6);
    canvas.setAttribute('aria-label', `${list.length} receiver timelines. Shaded spans meet the distance and duration settings. Full numeric values follow in the table. ${state.ui.blind ? 'Future observations hidden.' : ''}`);
    $('#allRoutesTable').innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr><th>Receiver</th><th>Nearest defender</th><th>Distance</th><th>Coverage Lift</th><th>Receiver Lift</th><th>Total / longest window</th><th>Eligible time open</th><th>First opening / release lead</th><th>Raw observations</th><th>Review</th></tr></thead><tbody>${list.map(receiver => {
      const value = M.context(play, receiver.id, frame(key), options()), stat = windows(play, receiver.id, statsThrough(key));
      return `<tr class="${String(receiver.id) === String(state.receivers[key]) ? 'selected' : ''}"><td>${esc(receiver.name)}</td><td>${esc(name(play, value.nearestId))}</td><td>${fmt(value.distance ?? value.separationAfter)} yd</td><td>${value.valid ? signed(value.coverage) : '—'} yd</td><td>${value.valid ? signed(value.receiver) : '—'} yd</td><td>${fmt(stat.total)} / ${fmt(stat.longest)} s</td><td>${fmt(stat.percentEligible)}% of ${fmt(stat.eligibleSeconds)} s</td><td>${finite(stat.timeToFirst) ? `+${fmt(stat.timeToFirst)} s` : 'No observed onset'}${!state.ui.blind && finite(stat.releaseLead) ? ` / ${fmt(stat.releaseLead)} s before release` : ''}</td><td>${stat.intervals?.length ?? 0} qualified / ${stat.rawIntervals?.length ?? stat.intervals?.length ?? 0} raw windows<br>${fmt(stat.rawTotal ?? stat.total)} s raw</td><td><button data-route="${esc(receiver.id)}">Follow</button><button data-pair-route="${esc(receiver.id)}">Pair</button></td></tr>`;
    }).join('')}</tbody></table></div>`;
    $$('[data-route]').forEach(button => button.addEventListener('click', () => { chooseReceiver(key, button.dataset.route); setTab('replay'); }));
    $$('[data-pair-route]').forEach(button => button.addEventListener('click', () => { chooseReceiver(key, button.dataset.pairRoute, true); state.ui.chart = 'pair'; setTab('replay'); }));
    renderEvents(); renderFourDistances();
  }

  function eventRecords(key = studyKey()) {
    const play = getPlay(key), id = state.receivers[key];
    const throughTime = state.ui.blind ? boardTime(key) : undefined;
    const result = M.events(play, id, options(finite(throughTime) ? { throughTime } : {}));
    return (Array.isArray(result) ? result : result?.events || []).map(event => ({ ...event, start: Number(event.start ?? event.onset ?? event.onsetTime ?? event.time ?? 0), end: Number(event.end ?? event.endTime ?? (event.start ?? event.time ?? 0) + (event.duration ?? event.hold ?? 0)) }));
  }

  function renderEvents() {
    const key = studyKey(), list = eventRecords(key), play = getPlay(key);
    $('#eventList').innerHTML = list.length ? `<div class="event-list">${list.map((event, index) => `<article class="event-card"><h3>Window at +${fmt(event.start)} s</h3><p>${fmt(event.end - event.start)} s observed hold · ${esc(name(play, state.receivers[key]))}</p><p>${event.leftCensored ? 'Already open at the eligible boundary. ' : ''}${event.rightCensored ? 'Still open when observation ends.' : ''}</p><p>Coverage Lift: ${signed(event.coverageLift?.coverage ?? event.coverageLift ?? event.coverage)} yd</p><button data-event="${index}">Jump here</button> <button data-loop-event="${index}">Loop the moment</button></article>`).join('')}</div>` : '<p class="empty-inline">No qualifying observed windows under these settings. Try another receiver, threshold or minimum hold.</p>';
    $$('[data-event]').forEach(button => button.addEventListener('click', () => { seek(list[Number(button.dataset.event)].start - offset(key)); setTab('replay'); }));
    $$('[data-loop-event]').forEach(button => button.addEventListener('click', () => {
      const event = list[Number(button.dataset.loopEvent)]; state.loop = { enabled: true, start: Math.max(0, event.start - offset(key) - .3), end: Math.min(duration(), Math.max(event.end - offset(key) + .3, event.start - offset(key) + .5)) };
      seek(state.loop.start); syncControls(); setTab('replay'); playReplay(); notify('loop');
    }));
  }

  function renderFourDistances() {
    const key = studyKey(), play = getPlay(key), at = frame(key), lift = M.coverageLift(play, state.receivers[key], at, options());
    if (!lift.valid) { $('#fourDistances').innerHTML = `<p class="empty-inline">${esc(lift.reason || 'Not enough eligible history.')}</p>`; return; }
    const receiver = playerById(play, state.receivers[key]), previous = lift.previousFrame;
    const oldPosition = receiver.track[previous], nowPosition = receiver.track[at];
    const start = M.inspectPoint(play, { x: oldPosition[0], y: oldPosition[1] }, previous, options()).distance;
    const receiverMoved = M.inspectPoint(play, { x: nowPosition[0], y: nowPosition[1] }, previous, options()).distance;
    const defenseMoved = M.inspectPoint(play, { x: oldPosition[0], y: oldPosition[1] }, at, options()).distance;
    const end = M.inspectPoint(play, { x: nowPosition[0], y: nowPosition[1] }, at, options()).distance;
    $('#fourDistances').innerHTML = `<div class="four-grid">${[['Start: old receiver, old defense', start], ['Receiver moved; defense held', receiverMoved], ['Defense moved; receiver held', defenseMoved], ['End: current receiver and defense', end]].map(([label, value]) => `<div>${label}<strong>${fmt(value, 2)} yd</strong></div>`).join('')}</div><div class="method-formula">½ × [(${fmt(defenseMoved, 2)} − ${fmt(start, 2)}) + (${fmt(end, 2)} − ${fmt(receiverMoved, 2)})] = <strong>${signed(lift.coverage)} yd Coverage Lift</strong></div>`;
  }

  function render(force = false) {
    if (!state.a || !state.boards.a) return;
    const signature = currentKeys().map(key => `${key}:${state[key]}:${frame(key)}:${state.receivers[key]}:${offset(key)}`).join('|') + JSON.stringify(state.preSnap);
    if (signature !== state.lastPaint) clearDiagnostics();
    for (const key of currentKeys()) { drawField(key); renderBoardMetrics(key); }
    $('#scrubber').max = chartDuration(); $('#scrubber').value = state.t; $('#endTime').textContent = state.ui.blind ? 'Future hidden' : `${fmt(duration())} s`; $('#currentTime').textContent = `${fmt(state.t)} s`;
    $('#scrubber').setAttribute('aria-valuetext', `${fmt(state.t)} seconds on aligned clock; play A observed at ${fmt(boardTime('a'))} seconds after snap`);
    updatePointInspector(); renderAllRoutes();
    if (signature !== state.lastPaint || force) { state.lastPaint = signature; notify('frame'); }
  }

  function seek(time, config = {}) {
    if (!config.keepPlaying) pause();
    state.preSnap = null; state.t = clamp(Number(time) || 0, 0, duration()); render(); notify('seek');
  }

  function pause() {
    state.playing = false; state.lastStamp = null;
    if (state.request !== null) cancelAnimationFrame(state.request);
    state.request = null;
    if ($('#playButton')) { $('#playButton').textContent = '▶'; $('#playButton').setAttribute('aria-label', 'Play replay'); }
  }

  function playReplay() {
    pause(); state.preSnap = null;
    if (state.t >= duration() - .001) state.t = 0;
    state.playing = true; $('#playButton').textContent = 'Ⅱ'; $('#playButton').setAttribute('aria-label', 'Pause replay');
    state.request = requestAnimationFrame(tick); notify('play');
  }

  function tick(stamp) {
    if (!state.playing) return;
    if (state.lastStamp !== null) state.t += Math.min(.15, (stamp - state.lastStamp) / 1000) * state.speed;
    state.lastStamp = stamp;
    if (state.loop.enabled && state.loop.end > state.loop.start && state.t >= state.loop.end) state.t = state.loop.start;
    state.t = Math.min(duration(), state.t);
    const signature = currentKeys().map(key => `${key}:${state[key]}:${frame(key)}:${state.receivers[key]}:${offset(key)}`).join('|') + JSON.stringify(state.preSnap);
    if (!state.ui.reducedMotion || signature !== state.lastPaint) render();
    if (state.t >= duration() - .00001) { pause(); notify('end'); }
    else state.request = requestAnimationFrame(tick);
  }

  function step(direction, count = 1) {
    const times = [...new Set(currentKeys().flatMap(key => getPlay(key).times.map(time => Number(time) - offset(key))).filter(time => time >= 0))].sort((a, b) => a - b);
    let target = state.t;
    for (let index = 0; index < count; index++) target = direction > 0 ? times.find(time => time > target + .00001) ?? duration() : times.filter(time => time < target - .00001).at(-1) ?? 0;
    seek(target);
  }

  function expandField() {
    state.ui.expanded = !state.ui.expanded; syncControls(); setTab('replay'); requestAnimationFrame(() => render(true)); notify('view');
  }

  function renderMatches() {
    if (!state.a) return;
    const reference = getPlay('a'), query = $('#comparisonSearch').value.trim().toLowerCase();
    const matches = M.compareMatches(reference, plays(), options({ limit: plays().length }));
    const rows = (Array.isArray(matches) ? matches : []).map(match => ({ ...match, play: byId(match.playId || match.id) })).filter(match => {
      const play = match.play; if (!play || String(play.id) === String(reference.id)) return false;
      if (query && !searchText(play).includes(query)) return false;
      if ($('#matchOffense').checked && play.offense !== reference.offense) return false;
      if ($('#matchCoverage').checked && play.coverage !== reference.coverage) return false;
      if ($('#matchFormation').checked && play.formation !== reference.formation) return false;
      if ($('#matchDown').checked && play.down !== reference.down) return false;
      return true;
    });
    $('#matchCount').textContent = `${rows.length} of ${Math.max(0, plays().length - 1)} candidates`;
    $('#matchList').innerHTML = rows.length ? rows.slice(0, 80).map(match => `<article class="match-card"><div><h3>${esc(playLabel(match.play))}</h3><p>${esc(match.play.formation || 'Unknown formation')} · ${match.play.down} & ${match.play.yardsToGo} · ${esc(match.play.offense)} offense</p><div>${(match.reasons || []).map(reason => `<span class="tag">${esc(typeof reason === 'string' ? reason : JSON.stringify(reason))}</span>`).join('')}${(match.mismatches || []).map(reason => `<span class="tag warn">${esc(typeof reason === 'string' ? reason : JSON.stringify(reason))}</span>`).join('')}</div><p>Context match ${fmt(match.score * 100, 0)}%${!state.ui.blind && qualityFlags(match.play).length ? ' · review quality flags' : ''}</p></div><button data-match="${esc(match.play.id)}">Compare as B</button></article>`).join('') : '<p class="empty-inline">No matches under these conditions. Relax a comparison filter to inspect a broader cohort.</p>';
    $$('[data-match]').forEach(button => button.addEventListener('click', () => { selectPlay('b', button.dataset.match, { preserveTime: true }); setTab('replay'); }));
  }

  function runDiagnostic(target, build) {
    if (state.preSnap) { $(target).innerHTML = '<p class="notice">Return to snap before calculating analytical findings.</p>'; return; }
    const source = getSnapshot(), sourceFrame = state.lastPaint, key = target === '#regionResults' ? state.region?.key || studyKey() : studyKey();
    $(target).innerHTML = '<p class="empty-inline">Calculating this observed frame…</p>';
    requestAnimationFrame(() => {
      if (sourceFrame !== state.lastPaint || JSON.stringify(source.metricOptions) !== JSON.stringify(state.metricOptions)) { $(target).innerHTML = ''; return; }
      try { $(target).innerHTML = `<p class="analysis-provenance">Play ${key.toUpperCase()} · ${esc(state[key])} · observed +${fmt(boardTime(key))} s · ${esc(name(getPlay(key), state.receivers[key]))} · ${fmt(state.metricOptions.lookback)} s lookback · ${fmt(state.threshold)} yd threshold · ${esc(state.metricOptions.scope)} scope</p>` + build(); }
      catch (error) { $(target).innerHTML = `<p class="empty-inline">Unable to calculate: ${esc(error.message)}</p>`; }
    });
  }

  function contributionAnalysis() {
    runDiagnostic('#contributionResults', () => {
      const key = studyKey(), play = getPlay(key), result = M.defenderContributions(play, state.receivers[key], frame(key), options());
      if (!result.valid) return `<p>${esc(result.reason || 'No valid contribution calculation for this frame.')}</p>`;
      const list = result.contributions || [], max = Math.max(.1, ...list.map(row => Math.abs(row.value)));
      return `<div class="diagnostic-result"><strong>Coverage Lift ${signed(result.coverage)} yd</strong>${list.map(row => `<div class="bar-row"><span>${esc(row.name || name(play, row.id))}</span><span class="signed-bar"><i style="left:${row.value >= 0 ? 50 : 50 - Math.abs(row.value) / max * 50}%;width:${Math.abs(row.value) / max * 50}%;background:${row.value >= 0 ? '#389272' : '#bf784e'}"></i></span><strong>${signed(row.value)} yd</strong></div>`).join('')}<p>Allocation total ${signed(result.total)} yd · numerical residual ${fmt(result.residual, 6)} yd. ${result.coalitions ?? 'All'} coalitions evaluated.</p><p class="non-causal">Each defender’s movement is exchanged between observed endpoint positions. The allocation shares geometric interactions; it does not identify responsibility or the cause of movement.</p></div>`;
    });
  }

  function assistAnalysis() {
    runDiagnostic('#assistResults', () => {
      const key = studyKey(), play = getPlay(key), result = M.assistCandidates(play, state.receivers[key], frame(key), options());
      if (!result.valid) return `<p>${esc(result.reason || 'No eligible linked-movement calculation.')}</p>`;
      const list = result.candidates || [];
      return `<div class="diagnostic-result">${list.length ? list.map(row => `<article class="event-card"><h3>${esc(row.name || name(play, row.id))} ↔ ${esc(name(play, state.receivers[key]))}</h3><p>${signed(row.associatedValue)} yd associated with the movement filter; score ${fmt(row.score, 2)}.</p><p>Defender(s): ${(row.defenderIds || []).map(id => esc(name(play, id))).join(', ')}</p><p>${esc(typeof row.evidence === 'string' ? row.evidence : JSON.stringify(row.evidence || {}))}</p><button data-assist-pair="${esc(row.id)}">Inspect this route pair</button></article>`).join('') : '<p>No route pair meets the movement criteria at this frame.</p>'}<p>Unassigned positive component: ${fmt(result.unassigned)} yd.</p><p class="non-causal">${esc(result.note || 'Association is not causal credit. Zone rotation and common reactions can produce co-movement.')}</p></div>`;
    });
  }

  function sensitivityAnalysis() {
    runDiagnostic('#sensitivityResults', () => {
      const key = studyKey(), result = M.sensitivity(getPlay(key), state.receivers[key], frame(key), options(state.ui.blind ? { throughTime: boardTime(key) } : {}));
      const jitter = result.jitter || {};
      return `<div class="diagnostic-result"><div class="table-scroll"><table class="data-table"><thead><tr><th>Distance threshold</th><th>Events</th><th>Total window</th><th>Longest</th></tr></thead><tbody>${(result.thresholds || []).map(row => `<tr><td>${fmt(row.threshold)} yd</td><td>${row.eventCount ?? '—'}</td><td>${fmt(row.total)} s</td><td>${fmt(row.longest)} s</td></tr>`).join('')}</tbody></table></div><div class="table-scroll"><table class="data-table"><thead><tr><th>Lookback</th><th>Coverage Lift</th><th>Receiver Lift</th></tr></thead><tbody>${(result.lookbacks || []).map(row => `<tr><td>${fmt(row.elapsed ?? row.lookback)} s</td><td>${row.valid ? signed(row.coverage) : 'Unavailable'} yd</td><td>${row.valid ? signed(row.receiver) : 'Unavailable'} yd</td></tr>`).join('')}</tbody></table></div><p>Position perturbation ±${fmt(jitter.amplitude, 2)} yd · ${jitter.samples ?? '—'} samples · Coverage Lift ${signed(jitter.min)} to ${signed(jitter.max)} yd · ${jitter.signStable ? 'sign remained stable' : 'sign may change'}.</p><p class="non-causal">This checks sensitivity to specified perturbations; the range is not a confidence interval or a calibrated tracking-error model.</p></div>`;
    });
  }

  function regionAnalysis() {
    if (!state.region) { status('Drag across the field to select a region first.'); return; }
    runDiagnostic('#regionResults', () => {
      const region = state.region, key = region.key, play = getPlay(key), result = M.regionSeries(play, region, options(state.ui.blind ? { throughTime: boardTime(key) } : {}));
      if (!result.valid) return `<p>${esc(result.reason || 'This region cannot be evaluated.')}</p>`;
      const values = (result.series || []).filter(row => !state.ui.blind || row.time <= boardTime(key) + 1e-6);
      const current = values.find(row => row.frame === frame(key)) || values.at(-1);
      const arrivals = values.flatMap(row => (row.arrivals || []).filter(arrival => arrival.entered).map(arrival => ({ ...arrival, time: row.time })));
      const peak = values.reduce((best, row) => row.openArea > (best?.openArea ?? -1) ? row : best, null);
      return `<div class="diagnostic-result"><div class="point-values"><span><strong>${fmt(result.area)} yd²</strong>Region area · ${result.points ?? '—'} sampled points</span><span><strong>${fmt(current?.openArea)} yd²</strong>Area ≥ threshold now</span><span><strong>${fmt(current?.meanSpace)} yd</strong>Mean nearest-defender distance now</span><span><strong>${signed(current?.meanChange)} yd</strong>Mean fixed-location change</span></div><p>Largest observed above-threshold area ${fmt(peak?.openArea)} yd² at +${fmt(peak?.time)} s. This is a spacing condition, not a guaranteed usable throwing region.</p><div class="table-scroll"><table class="data-table"><thead><tr><th>Receiver arrival</th><th>Time</th><th>Arrival-point spacing</th><th>Opening → arrival</th></tr></thead><tbody>${arrivals.map(arrival => `<tr><td>${esc(arrival.name || name(play, arrival.id))}</td><td>+${fmt(arrival.time)} s</td><td>${arrival.open ? '≥ distance threshold' : 'Below distance threshold'}</td><td>${finite(arrival.openingToArrival) ? `${fmt(arrival.openingToArrival)} s after opening at +${fmt(arrival.openingOnsetAtArrivalLocation)} s` : arrival.open ? 'Onset not observed / boundary censored' : 'Not open at arrival'}</td></tr>`).join('') || '<tr><td colspan="4">No true receiver entries observed during this interval.</td></tr>'}</tbody></table></div><p>Opening-to-arrival holds the eventual arrival location fixed and measures time from its latest observed threshold crossing to the receiver’s true rectangle entry. It uses raw observed crossings without a minimum hold; no onset is inferred when the location was already open at the first observation. Region-average openness is a separate measure.</p><details><summary>Region time series</summary><div class="table-scroll"><table class="data-table"><thead><tr><th>Time</th><th>Mean space</th><th>Open area</th><th>Mean change</th></tr></thead><tbody>${values.map(row => `<tr><td>${fmt(row.time)} s</td><td>${fmt(row.meanSpace)} yd</td><td>${fmt(row.openArea)} yd²</td><td>${signed(row.meanChange)} yd</td></tr>`).join('')}</tbody></table></div></details></div>`;
    });
  }

  function jumpWindow(direction) {
    const key = studyKey(), list = eventRecords(key), time = boardTime(key);
    const event = direction > 0 ? list.find(row => row.start > time + .001) : list.filter(row => row.start < time - .001).at(-1);
    if (event) { seek(event.start - offset(key)); setTab('replay'); }
    else status(`No ${direction > 0 ? 'later' : 'earlier'} qualifying opening under these settings.`);
  }

  function metricChange() {
    cache.clear(); heatCache.clear(); clearDiagnostics(); syncControls(); applyFilters(); renderMatches(); render(true); notify('metric');
  }

  function exportView() {
    if (window.OpenFieldWorkspace?.exportPNG) return window.OpenFieldWorkspace.exportPNG();
    const key = studyKey(), canvas = document.createElement('canvas');
    renderField(key, canvas, { width: 1400, height: 900, exporting: true });
    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `open-field-${state[key]}-${fmt(boardTime(key))}s.png`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  function loadDataset(payload) {
    if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.plays) || !payload.plays.length) throw new Error('This is not a compatible nonempty Open Field game pack.');
    for (const play of payload.plays) if (!play.id || !Array.isArray(play.times) || !play.times.length || !Array.isArray(play.players)) throw new Error('The game pack contains an incomplete play.');
    pause(); data = payload; state.b = null; state.a = String(plays()[0].id); state.t = 0; state.point = null; state.region = null; state.preSnap = null;
    state.filters = { search: '', game: '', offense: '', defense: '', coverage: '', formation: '', down: '', quality: '', penalty: '', sort: 'source' };
    cache.clear(); heatCache.clear(); remembered.clear(); state.receivers.a = defaultReceiver(getPlay('a')); state.focusPlayers.a = state.receivers.a;
    populateFilters(); applyFilters(); setupStories(); rebuildBoards(); syncControls(); renderMatches(); setTab('replay'); render(true); notify('dataset');
    return { playCount: plays().length, gameCount: data.meta?.gameCount };
  }

  function bindControls() {
    $('#search').addEventListener('input', event => { state.filters.search = event.target.value; applyFilters(); notify('filter'); });
    const filters = { filterGame: 'game', filterOffense: 'offense', filterDefense: 'defense', filterCoverage: 'coverage', filterFormation: 'formation', filterDown: 'down', filterQuality: 'quality', filterPenalty: 'penalty', sortPlays: 'sort' };
    for (const [id, key] of Object.entries(filters)) $(`#${id}`).addEventListener('change', event => { state.filters[key] = event.target.value; applyFilters(); notify('filter'); });
    $('#resetFilters').addEventListener('click', () => { for (const key of Object.keys(state.filters)) state.filters[key] = key === 'sort' ? 'source' : ''; populateFilters(); applyFilters(); notify('filter'); });
    $$('[data-tab]').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
    $$('[data-mode]').forEach(button => button.addEventListener('click', () => { state.mode = button.dataset.mode; syncControls(); render(true); notify('mode'); }));
    $('#threshold').addEventListener('input', event => { state.threshold = Number(event.target.value); metricChange(); });
    $('#roleScope').addEventListener('change', event => { state.metricOptions.scope = event.target.value; metricChange(); });
    $('#lookback').addEventListener('change', event => { state.metricOptions.lookback = Number(event.target.value); metricChange(); });
    $('#minDuration').addEventListener('change', event => { state.metricOptions.minDuration = Number(event.target.value); metricChange(); });
    $('#downfieldOnly').addEventListener('change', event => { state.downfieldOnly = event.target.checked; metricChange(); });
    $('#inBoundsOnly').addEventListener('change', event => { state.metricOptions.inBoundsOnly = event.target.checked; metricChange(); });
    $('#statsMode').addEventListener('change', event => { state.ui.statsMode = event.target.value; render(); notify('stats'); });
    $('#studyBoard').addEventListener('change', event => { state.ui.studyBoard = event.target.value; clearDiagnostics(); render(); notify('study'); });
    $('#compareButton').addEventListener('click', () => {
      if (state.b) { state.b = null; state.t = clamp(state.t, 0, duration()); rebuildBoards(); syncControls(); render(); notify('compare'); }
      else { const match = M.compareMatches(getPlay('a'), plays(), options()).find(row => String(row.playId || row.id) !== state.a); const id = match?.playId || match?.id || plays().find(play => String(play.id) !== state.a)?.id; if (id) selectPlay('b', id, { preserveTime: true }); }
    });
    $('#compareSelect').addEventListener('change', event => selectPlay('b', event.target.value, { preserveTime: true }));
    $('#removeCompare').addEventListener('click', () => { state.b = null; state.t = clamp(state.t, 0, duration()); rebuildBoards(); syncControls(); render(); notify('compare'); });
    $('#swapCompare').addEventListener('click', () => { if (!state.b) return; [state.a, state.b] = [state.b, state.a]; for (const field of ['receivers', 'focusPlayers', 'pairReceivers']) [state[field].a, state[field].b] = [state[field].b, state[field].a]; rebuildBoards(); renderLibrary(); syncControls(); render(); notify('compare'); });
    $('#alignment').addEventListener('change', event => { state.alignment = event.target.value; state.t = clamp(state.t, 0, duration()); syncControls(); render(); notify('alignment'); });
    for (const [id, key] of [['manualAnchorA', 'a'], ['manualAnchorB', 'b']]) $(`#${id}`).addEventListener('change', event => {
      if (!getPlay(key)) return;
      state.manualAnchors[key] = clamp(Number(event.target.value) || 0, 0, endTime(getPlay(key)));
      state.t = clamp(state.t, 0, duration()); syncControls(); render(); notify('alignment');
    });
    $('#captureAnchors').addEventListener('click', () => { const anchors = Object.fromEntries(currentKeys().map(key => [key, boardTime(key)])); Object.assign(state.manualAnchors, anchors); state.alignment = 'manual'; state.t = Math.max(...Object.values(anchors)); syncControls(); render(); notify('alignment'); });
    $('#compareSamePlay').addEventListener('click', () => { const id = state.a, other = routes(getPlay('a')).find(player => String(player.id) !== String(state.receivers.a)); selectPlay('b', id, { preserveTime: true }); if (other) { state.receivers.b = String(other.id); state.focusPlayers.b = String(other.id); } syncBoardControls(); setTab('replay'); render(); });
    $('#comparisonSearch').addEventListener('input', renderMatches);
    for (const id of ['matchOffense', 'matchCoverage', 'matchFormation', 'matchDown']) $(`#${id}`).addEventListener('change', renderMatches);
    $('#storySelect').addEventListener('change', event => { if (event.target.value !== '') applyStory(Number(event.target.value)); });
    $('#storyCompare').addEventListener('click', () => { if (state.storyIndex !== null) applyStory(state.storyIndex, true); });
    $('#resetButton').addEventListener('click', () => seek(0)); $('#stepBack').addEventListener('click', () => step(-1)); $('#stepForward').addEventListener('click', () => step(1));
    $('#playButton').addEventListener('click', () => state.playing ? pause() : playReplay());
    $('#scrubber').addEventListener('input', event => seek(Number(event.target.value)));
    $('#speed').addEventListener('change', event => { state.speed = Number(event.target.value); notify('speed'); });
    $('#loopButton').addEventListener('click', () => { state.loop.enabled = !state.loop.enabled; if (state.loop.end <= state.loop.start) state.loop.end = Math.min(duration(), state.loop.start + 1); syncControls(); notify('loop'); });
    $('#loopStart').addEventListener('change', event => { state.loop.start = clamp(Number(event.target.value) || 0, 0, duration() - .1); state.loop.end = Math.max(state.loop.start + .1, state.loop.end); syncControls(); notify('loop'); });
    $('#loopEnd').addEventListener('change', event => { state.loop.end = clamp(Number(event.target.value) || 0, state.loop.start + .1, duration()); syncControls(); notify('loop'); });
    $('#loopHere').addEventListener('click', () => { state.loop = { enabled: true, start: Math.max(0, state.t - .4), end: Math.min(duration(), state.t + .6) }; syncControls(); notify('loop'); });
    $('#previousWindow').addEventListener('click', () => jumpWindow(-1)); $('#nextWindow').addEventListener('click', () => jumpWindow(1));
    $('#jumpRelease').addEventListener('click', () => { const key = studyKey(); seek(endTime(getPlay(key)) - offset(key)); setTab('replay'); });
    $('#jumpPeak').addEventListener('click', () => { const key = studyKey(), play = getPlay(key), values = series(play, state.receivers[key]).filter((row, index) => row.valid && (!state.ui.blind || index <= frame(key))); const peak = values.reduce((best, row) => row.coverage > (best?.coverage ?? -Infinity) ? row : best, null); if (peak) { const time = peak.time ?? play.times[peak.frame]; seek(Number(time) - offset(key)); setTab('replay'); } else status('No valid Coverage Lift window in the observed interval.'); });
    $('#analyzeContributions').addEventListener('click', contributionAnalysis); $('#analyzeAssists').addEventListener('click', assistAnalysis); $('#analyzeSensitivity').addEventListener('click', sensitivityAnalysis); $('#analyzeRegion').addEventListener('click', regionAnalysis);
    $('#assistResults').addEventListener('click', event => { const button = event.target.closest('[data-assist-pair]'); if (!button) return; chooseReceiver(studyKey(), button.dataset.assistPair, true); state.ui.chart = 'pair'; setTab('replay'); });
    $('#inspectCoordinates').addEventListener('click', () => { const key = $('#inspectBoard').value === 'b' && state.b ? 'b' : 'a'; state.point = { key, x: clamp(Number($('#inspectX').value) || 0, 0, 120), y: clamp(Number($('#inspectY').value) || 0, 0, 53.3) }; state.region = null; render(); notify('inspection'); });
    $('#clearRegion').addEventListener('click', () => { state.point = null; state.region = null; $('#pointInspector').innerHTML = '<p class="empty-inline">Click grass to pin a point, or drag a region.</p>'; $('#regionResults').innerHTML = ''; render(); notify('inspection'); });
    $('#methodButton').addEventListener('click', () => $('#methodDialog').showModal()); $('#closeMethod').addEventListener('click', () => $('#methodDialog').close());
    $('#settingsButton').addEventListener('click', () => $('#settingsDialog').showModal()); $$('[data-close]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
    $$('[data-layer]').forEach(input => input.addEventListener('change', () => { state.layers[input.dataset.layer] = input.checked; render(); notify('layer'); }));
    $('#heatMask').addEventListener('change', event => { state.layers.mask = event.target.value; heatCache.clear(); render(); notify('layer'); if (state.layers.mask === 'region' && !state.region) status('Drag a region on the field to reveal its heatmap. The metric itself is unchanged.'); });
    for (const [id, key] of [['heatOpacity', 'opacity'], ['trailLength', 'trail'], ['labelMode', 'labels']]) $(`#${id}`).addEventListener(id === 'heatOpacity' ? 'input' : 'change', event => { state.layers[key] = key === 'opacity' ? Number(event.target.value) : event.target.value; render(); notify('layer'); });
    $('#shapeMarkers').addEventListener('change', event => { state.layers.shapes = event.target.checked; render(); notify('layer'); });
    for (const id of ['largeText', 'highContrast', 'reducedMotion']) $(`#${id}`).addEventListener('change', event => { state.ui[id] = event.target.checked; syncControls(); requestAnimationFrame(() => render(true)); notify('view'); });
    $('#fieldZoom').addEventListener('change', event => { state.ui.zoom = Number(event.target.value); heatCache.clear(); render(); notify('zoom'); });
    $('#fullscreenButton').addEventListener('click', () => { $('#settingsDialog').close(); expandField(); });
    $('#collapseLibrary').addEventListener('click', () => { state.ui.libraryCollapsed = !state.ui.libraryCollapsed; syncControls(); requestAnimationFrame(() => render(true)); notify('view'); });
    $('#preSnapButton').addEventListener('click', () => {
      const key = studyKey(), play = getPlay(key); pause();
      if (!play.preSnap?.times?.length) { $('#preSnapStatus').textContent = 'No complete pre-snap frames are available for this play.'; $('#preSnapControls').classList.remove('hidden'); return; }
      state.preSnap = { key, index: play.preSnap.times.length - 1 }; $('#preSnapControls').classList.remove('hidden'); $('#preSnapSlider').max = play.preSnap.times.length - 1; $('#preSnapSlider').value = state.preSnap.index; $('#preSnapStatus').textContent = `${play.preSnap.times.length} observed pre-snap frames. Metrics are paused in this preview.`; render(); notify('presnap');
    });
    $('#preSnapSlider').addEventListener('input', event => { if (state.preSnap) { state.preSnap.index = Number(event.target.value); render(); notify('presnap'); } });
    $('#returnSnap').addEventListener('click', () => { state.preSnap = null; $('#preSnapControls').classList.add('hidden'); seek(0); });
    $('#exportButton').addEventListener('click', exportView);
    document.addEventListener('keydown', event => {
      if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || $$('dialog[open]').length) return;
      if (event.code === 'Space' && event.target.tagName !== 'BUTTON') { event.preventDefault(); state.playing ? pause() : playReplay(); }
      if (event.ctrlKey && ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.code) && event.target.classList.contains('field-canvas')) {
        event.preventDefault(); const key = event.target.closest('[data-board]').dataset.board;
        if (!state.point || state.point.key !== key) state.point = { key, x: getPlay(key).los, y: 26.65 };
        state.point.x = clamp(state.point.x + (event.code === 'ArrowRight' ? 1 : event.code === 'ArrowLeft' ? -1 : 0), 0, 120);
        state.point.y = clamp(state.point.y + (event.code === 'ArrowUp' ? 1 : event.code === 'ArrowDown' ? -1 : 0), 0, 53.3);
        render(); notify('inspection'); return;
      }
      if (event.code === 'ArrowRight' || event.code === 'ArrowLeft') { event.preventDefault(); step(event.code === 'ArrowRight' ? 1 : -1, event.shiftKey ? 10 : 1); }
      if (event.key === '[') jumpWindow(-1); if (event.key === ']') jumpWindow(1);
      if (event.key.toLowerCase() === 'f') expandField();
      if (event.key === 'Escape' && state.ui.expanded) expandField();
    });
    let resizeTimer;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => render(true), 70); });
  }

  function initialize() {
    mount();
    if (!M || !data?.plays?.length) {
      $('#app').innerHTML = '<main class="fatal"><h1>The coaching data is unavailable.</h1><p>Build a complete Open Field bundle with its metric engine and an observed game pack, then reopen the page.</p></main>'; return;
    }
    state.ui.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
    state.a = String(data.featured?.[0] || plays()[0].id);
    if (!byId(state.a)) state.a = String(plays()[0].id);
    state.receivers.a = defaultReceiver(getPlay('a')); state.focusPlayers.a = state.receivers.a;
    populateFilters(); applyFilters(); setupStories(); rebuildBoards(); bindControls(); syncControls(); renderMatches();
    window.OpenFieldApp = {
      state, metrics: M, get data() { return data; }, getSnapshot, setSnapshot, selectPlay, chooseReceiver,
      getBoards: () => state.boards, getPlay, getReceiver: key => playerById(getPlay(key), state.receivers[key]),
      getObservedTime: observedTime, getPreSnap: () => state.preSnap && { ...state.preSnap }, getFrame: frame,
      getTimeOffset: offset, getDuration: duration, getOffsets: () => Object.fromEntries(currentKeys().map(key => [key, offset(key)])),
      seek, render, renderField, drawField, pause, play: playReplay, step, exportView, loadDataset, setTab,
      viewBounds, frameAt, status, getSeries: series, getWindows: windows, getContext: context
    };
    if (state.stories.length) applyStory(0); else render(true);
    document.dispatchEvent(new CustomEvent('openfield:ready', { detail: { api: window.OpenFieldApp } }));
  }
  initialize();
})();
