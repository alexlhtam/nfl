/* Portable coaching workspace. Loaded after the metric engine and replay UI. */
(() => {
  'use strict';
  const app = window.OpenFieldApp;
  const host = document.getElementById('workspaceTools');
  if (!app || !host) return;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const fmt = (value, precision = 2) => Number.isFinite(value) ? value.toFixed(precision) : '—';
  const signed = value => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${fmt(value)}` : '—';
  function storageIdentity(data) {
    return 'open-field-workspace-v2:' + (data.meta.datasetSha256 || [data.meta.sourceRevision, data.meta.buildId, data.plays.map(p => p.id).join(',')].join(':'));
  }
  const emptyWorkspace = () => ({version: 2, notes: {}, bookmarks: [], playlists: [], presets: [], annotations: [], labels: {}, exercises: []});
  let storageKey = storageIdentity(app.data);
  const memoryWorkspaces = new Map();
  let storageAvailable = true;
  let workspace = emptyWorkspace();
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (stored && stored.version === 2) workspace = validateWorkspace(stored);
  } catch (_) { storageAvailable = false; }
  let annotationDraft = null;
  let recorder = null;
  let recordingStopped = false;
  let lastPlayIds = '';
  const attachedCanvases = new WeakSet();
  const memoryNotes = new Map();
  const trustedPacks = structuredClone(app.data.meta.trustedGamePacks || []);
  const verifiedContext = app.data.meta.outcomeContext;

  host.innerHTML = `
    <style>
      .workspace-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr));gap:16px}
      .workspace-card{background:var(--white,#fff);border:1px solid var(--line,#dce3df);padding:16px;border-radius:12px;min-width:0}
      .workspace-card h3{margin:0 0 10px;font-size:16px}.workspace-card p,.workspace-help{font-size:12px;color:var(--muted,#637475)}
      .workspace-card label{display:block;margin:8px 0;font-size:12px}.workspace-card input:not([type=checkbox]),.workspace-card select,.workspace-card textarea{width:100%;padding:9px;border:1px solid var(--line,#dce3df);border-radius:7px;background:#fff;color:#182c2d}
      .workspace-card textarea{min-height:78px;resize:vertical}.workspace-actions{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0}.workspace-actions button{min-height:38px}
      .workspace-list{max-height:230px;overflow:auto;display:grid;gap:6px}.workspace-list button{text-align:left}.workspace-note{padding:9px;border:1px solid #dce3df;border-radius:7px;white-space:pre-wrap;font-size:12px}
      #ofWorkspaceStatus{min-height:22px;font-size:12px;margin:10px 0;color:#176d58}#ofWorkspaceStatus[data-error=true]{color:#a02f27}
      .workspace-card video{width:100%;max-height:260px;background:#102c2d;border-radius:8px}.workspace-card .workspace-inline{display:flex;gap:8px;align-items:center}
      .workspace-card .workspace-inline label{flex:1}.workspace-note button{float:right;margin-left:8px}
    </style>
    <p class="workspace-help">Keep a complete coaching finding: plays, time, parameters, annotations and notes. Files stay on this computer until you choose to share them.</p>
    <div id="ofWorkspaceStatus" role="status" aria-live="polite"></div>
    <div class="workspace-grid">
      <section class="workspace-card" aria-label="Saved analysis">
        <h3>Save this finding</h3>
        <label>Finding title<input id="ofBookmarkTitle" placeholder="Coverage moves away as the route arrives"></label>
        <div class="workspace-actions"><button id="ofSaveBookmark">Save moment</button><button id="ofCopyLink">Copy replay link</button><button id="ofExportSession">Export workspace</button></div>
        <label>Import workspace<input id="ofImportSession" type="file" accept=".json,application/json"></label>
        <div id="ofBookmarkList" class="workspace-list"></div>
        <p class="workspace-help">A replay link opens the same view against the same dataset; use a workspace file to include notes and drawings.</p>
      </section>
      <section class="workspace-card" aria-label="Coaching notes">
        <h3>Notes at this moment</h3>
        <label>Play<select id="ofNoteBoard"><option value="a">Play A</option><option value="b">Play B</option></select></label>
        <p id="ofNoteContext" class="workspace-help"></p>
        <label>Observation<textarea id="ofNoteText" placeholder="What changed, and what would you review?"></textarea></label>
        <div class="workspace-actions"><button id="ofSaveNote">Attach note to this moment</button><button id="ofExportNotes">Export notes</button></div>
        <div id="ofNoteList" class="workspace-list"></div>
      </section>
      <section class="workspace-card" aria-label="Coach annotations">
        <h3>Draw and label</h3>
        <label>Field tool<select id="ofDrawTool"><option value="off">Inspect players and field</option><option value="arrow">Draw arrow</option><option value="circle">Draw circle</option><option value="text">Place text</option></select></label>
        <label>Annotation text<input id="ofDrawText" placeholder="Opening behind the defender"></label>
        <div class="workspace-actions"><button id="ofUndoDraw">Undo last drawing</button><button id="ofClearDraw">Clear drawings for this play</button></div>
        <label>Route concept / assignment<input id="ofCoachLabel" placeholder="Your interpretation, not a source label"></label>
        <button id="ofSaveLabel">Save coach label</button><p id="ofLabelStatus" class="workspace-help"></p>
        <p class="workspace-help">Drawings attach to the observed frame. Coach labels are separate from measured data and scouting labels.</p>
      </section>
      <section class="workspace-card" aria-label="Playlists and filters">
        <h3>Organize a review</h3>
        <label>Playlist<select id="ofPlaylist"></select></label>
        <label>New playlist name<input id="ofPlaylistName" placeholder="Openings before release"></label>
        <div class="workspace-actions"><button id="ofCreatePlaylist">Create playlist</button><button id="ofAddPlaylist">Add this moment</button><button id="ofNextPlaylist">Next playlist moment</button></div>
        <div id="ofPlaylistItems" class="workspace-list"></div>
        <label>Saved filters<select id="ofFilterPreset"></select></label>
        <label>Filter preset name<input id="ofFilterName" placeholder="Third down against Cover 3"></label>
        <div class="workspace-actions"><button id="ofSaveFilters">Save filters</button><button id="ofApplyFilters">Apply filters</button></div>
      </section>
      <section class="workspace-card" aria-label="Export findings">
        <h3>Export the evidence</h3>
        <label>Question or title<input id="ofExportTitle" placeholder="Where did the opening come from?"></label>
        <div class="workspace-actions"><button id="ofExportPNG">Annotated image</button><button id="ofExportCSV">Metric CSV</button><button id="ofExportReport">Coaching report</button></div>
        <div class="workspace-inline"><label>Clip start (s)<input id="ofClipStart" type="number" min="0" step="0.1" value="0"></label><label>Clip end (s)<input id="ofClipEnd" type="number" min="0" step="0.1" value="3"></label></div>
        <div class="workspace-actions"><button id="ofRecordClip">Export replay clip</button><button id="ofStopRecording" disabled>Stop recording</button></div>
        <p class="workspace-help">Clips use this browser's video encoder. Images render the field directly at export resolution. Metadata identifies the exact analysis.</p>
      </section>
      <section class="workspace-card" aria-label="Data packs and practice">
        <h3>Data and practice</h3>
        <label>Open a game pack<input id="ofImportPack" type="file" accept=".json,application/json"></label>
        <p id="ofPackContext" class="workspace-help"></p>
        <label><input id="ofBlind" type="checkbox"> Read the play: hide future observations and outcome</label>
        <label><input id="ofBaseline" type="checkbox"> Ordinary replay: hide analytical overlays</label>
        <div class="workspace-actions"><button id="ofPractice">Random practice moment</button><button id="ofReveal">Reveal continuation</button></div>
        <label>Your read before reveal<textarea id="ofPracticeRead" placeholder="Describe the space and the movements you would inspect."></textarea></label>
        <p class="workspace-help">Self-directed practice has no automatic “correct throw” grade. No coach-reviewed or participant-study results are claimed.</p>
      </section>
    </div>`;

  function status(text, error = false) {
    $('ofWorkspaceStatus').textContent = text;
    $('ofWorkspaceStatus').dataset.error = String(error);
  }
  function uid() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  function snapshot() { return app.getSnapshot(); }
  function playFor(key) { return app.data.plays.find(p => String(p.id) === String(snapshot()[key])); }
  function effectiveTime(key, snap = snapshot()) {
    // UI supplies observed per-board time when alignments use different origins.
    if (typeof app.getObservedTime === 'function') return app.getObservedTime(key);
    const p = playFor(key);
    return p ? Math.min(Math.max(0, Number(snap.t) || 0), p.times[p.times.length - 1]) : 0;
  }
  function options(snap = snapshot(), key = 'a') { return {...(snap.metricOptions || {}), ...(snap.ui?.blind ? {throughTime: effectiveTime(key, snap)} : {})}; }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(workspace)); storageAvailable = true; }
    catch (_) { storageAvailable = false; }
    if (!storageAvailable) status('Saved in this session. Browser storage is unavailable; export the workspace to retain it.');
  }
  function cleanText(value, limit = 50000) { return typeof value === 'string' ? value.slice(0, limit) : ''; }
  function validSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing replay state.');
    if (typeof value.a !== 'string' || !Number.isFinite(value.t)) throw new Error('Invalid replay play or time.');
    return JSON.parse(JSON.stringify(value));
  }
  function validateWorkspace(value) {
    if (!value || value.version !== 2 || typeof value.notes !== 'object' || Array.isArray(value.notes)) throw new Error('This is not a version 2 Open Field workspace.');
    const result = {version: 2, notes: {}, bookmarks: [], playlists: [], presets: [], annotations: [], labels: {}, exercises: []};
    for (const [id, notes] of Object.entries(value.notes || {})) {
      if (!Array.isArray(notes) || notes.length > 5000) throw new Error('Invalid note list.');
      result.notes[id] = notes.map(n => ({id: cleanText(n.id, 100) || uid(), text: cleanText(n.text), time: Number(n.time) || 0, receiverId: cleanText(n.receiverId, 100), state: n.state ? validSnapshot(n.state) : null}));
    }
    for (const name of ['bookmarks', 'playlists', 'presets', 'annotations', 'exercises']) {
      if (!Array.isArray(value[name] || []) || (value[name] || []).length > 10000) throw new Error(`Invalid ${name}.`);
      result[name] = JSON.parse(JSON.stringify(value[name] || []));
    }
    result.bookmarks.forEach(b => validSnapshot(b.state));
    result.playlists.forEach(p => { if (!Array.isArray(p.items)) throw new Error('Invalid playlist.'); p.items.forEach(i => validSnapshot(i.state)); });
    result.annotations.forEach(a => {
      if (!['arrow', 'circle', 'text'].includes(a.type) || !Array.isArray(a.points) || a.points.length !== 2 || !a.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) throw new Error('Invalid field drawing.');
    });
    for (const [id, label] of Object.entries(value.labels || {})) result.labels[id] = cleanText(label, 2000);
    return result;
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  function jsonDownload(value, name) { download(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}), name); }
  function viewId(snap = snapshot()) {
    let hash = 2166136261;
    for (const char of JSON.stringify(snap)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
  function filename(extension) {
    const s = snapshot();
    return `open-field-${s.a}${s.b ? '-vs-' + s.b : ''}-${viewId(s)}.${extension}`;
  }
  function renderLists() {
    $('ofBookmarkList').innerHTML = workspace.bookmarks.map((b, i) => `<button data-bookmark="${i}">${esc(b.title || 'Saved moment')} · ${fmt(b.state.t, 1)}s</button>`).join('') || '<p class="workspace-help">No saved moments yet.</p>';
    $('ofBookmarkList').querySelectorAll('[data-bookmark]').forEach(button => button.onclick = () => restore(workspace.bookmarks[Number(button.dataset.bookmark)].state));
    const oldPlaylist = $('ofPlaylist').value;
    $('ofPlaylist').innerHTML = workspace.playlists.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${p.items.length})</option>`).join('') || '<option value="">Create a playlist</option>';
    if (workspace.playlists.some(p => p.id === oldPlaylist)) $('ofPlaylist').value = oldPlaylist;
    const selected = workspace.playlists.find(p => p.id === $('ofPlaylist').value);
    $('ofPlaylistItems').innerHTML = (selected?.items || []).map((p, i) => `<button data-playlist-item="${i}">${i + 1}. ${esc(p.title)} · ${fmt(p.state.t, 1)}s</button>`).join('');
    $('ofPlaylistItems').querySelectorAll('[data-playlist-item]').forEach(button => button.onclick = () => { selected.cursor = Number(button.dataset.playlistItem); restore(selected.items[selected.cursor].state); });
    $('ofFilterPreset').innerHTML = workspace.presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('') || '<option value="">No saved filters</option>';
    renderNotes();
  }
  function restore(value) {
    try { app.pause(); app.setSnapshot(validSnapshot(value)); status('Saved analysis restored.'); }
    catch (error) { status(`Cannot restore this analysis: ${error.message}`, true); }
  }
  function renderNotes() {
    const key = $('ofNoteBoard').value;
    const p = playFor(key), s = snapshot();
    if (!p) { $('ofNoteContext').textContent = 'Choose a comparison play to annotate play B.'; $('ofNoteList').innerHTML = ''; return; }
    const receiver = p.players.find(x => String(x.id) === String(s.receivers?.[key]));
    $('ofNoteContext').textContent = `${p.offense} vs ${p.defense} · ${p.id} · ${fmt(effectiveTime(key), 1)} s · ${receiver?.name || 'No receiver'}`;
    const notes = (workspace.notes[p.id] || []).filter(n => !s.ui?.blind || n.time <= effectiveTime(key));
    $('ofNoteList').innerHTML = notes.map((n, i) => `<div class="workspace-note"><button data-note-jump="${i}" aria-label="Open note at ${fmt(n.time, 1)} seconds">${fmt(n.time, 1)}s ↗</button>${esc(n.text)}</div>`).join('') || '<p class="workspace-help">No notes on this play yet.</p>';
    $('ofNoteList').querySelectorAll('[data-note-jump]').forEach(b => b.onclick = () => {
      const note = notes[Number(b.dataset.noteJump)];
      if (note.state) restore(note.state); else app.seek(note.time);
    });
    $('ofCoachLabel').value = workspace.labels[p.id] || '';
    $('ofLabelStatus').textContent = workspace.labels[p.id] ? 'Coach annotation; not a measured assignment.' : '';
  }
  function activeNoteId() { return playFor($('ofNoteBoard').value)?.id || 'no-play'; }
  $('ofNoteText').addEventListener('input', () => memoryNotes.set(activeNoteId(), $('ofNoteText').value));
  $('ofNoteBoard').onchange = () => { $('ofNoteText').value = memoryNotes.get(activeNoteId()) || ''; renderNotes(); };
  $('ofSaveNote').onclick = () => {
    const p = playFor($('ofNoteBoard').value), text = $('ofNoteText').value.trim();
    if (!p || !text) return status('Choose a play and enter an observation.', true);
    const s = snapshot();
    (workspace.notes[p.id] ||= []).push({id: uid(), text, time: effectiveTime($('ofNoteBoard').value), receiverId: s.receivers?.[$('ofNoteBoard').value] || '', state: s});
    memoryNotes.delete(p.id); $('ofNoteText').value = ''; save(); renderNotes(); status('Timestamped note attached.' + (storageAvailable ? '' : ' Export the workspace to retain it.'));
  };
  $('ofSaveLabel').onclick = () => { const p = playFor($('ofNoteBoard').value); if (p) { workspace.labels[p.id] = $('ofCoachLabel').value; save(); renderNotes(); } };
  $('ofSaveBookmark').onclick = () => {
    workspace.bookmarks.push({id: uid(), title: $('ofBookmarkTitle').value.trim() || 'Coaching finding', state: snapshot()}); save(); renderLists(); status('Moment saved.');
  };
  $('ofExportSession').onclick = () => jsonDownload({type: 'open-field-workspace', dataset: datasetIdentity(), snapshot: snapshot(), workspace}, filename('workspace.json'));
  $('ofExportNotes').onclick = () => {
    const s = snapshot(), notes = s.ui?.blind ? {} : workspace.notes;
    if (s.ui?.blind) for (const key of ['a', 'b']) { const p = playFor(key); if (p) notes[p.id] = (workspace.notes[p.id] || []).filter(n => n.time <= effectiveTime(key)); }
    const annotations = s.ui?.blind ? workspace.annotations.filter(a => ['a', 'b'].some(key => playFor(key)?.id === a.playId && a.time <= effectiveTime(key))) : workspace.annotations;
    jsonDownload({dataset: datasetIdentity(), notes, labels: s.ui?.blind ? {} : workspace.labels, annotations}, filename('notes.json'));
  };
  $('ofImportSession').onchange = async event => {
    try {
      const value = await readJSON(event.target.files[0]);
      if (value.type !== 'open-field-workspace') throw new Error('Choose an exported Open Field workspace.');
      const next = validateWorkspace(value.workspace);
      const state = validSnapshot(value.snapshot);
      requireDataset(value.dataset);
      if (!app.data.plays.some(p => p.id === state.a)) throw new Error('Load the matching game pack before importing this workspace.');
      app.setSnapshot(state); workspace = next; save(); renderLists(); app.render(); status('Workspace imported.');
    } catch (error) { status(error.message, true); }
    event.target.value = '';
  };
  function encodeFragment(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeFragment(value) {
    const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, char => char.charCodeAt(0))));
  }
  $('ofCopyLink').onclick = async () => {
    const fragment = 'view=' + encodeFragment({dataset: datasetIdentity(), snapshot: snapshot()});
    const link = location.href.split('#')[0] + '#' + fragment;
    try { history.replaceState(null, '', '#' + fragment); } catch (_) { /* file URL history can be restricted */ }
    try { await navigator.clipboard.writeText(link); status('Replay link copied. It requires the same dataset or shared HTML file.'); }
    catch (_) { download(new Blob([link], {type: 'text/plain'}), filename('link.txt')); status('Replay link downloaded because clipboard access is unavailable.'); }
  };
  $('ofCreatePlaylist').onclick = () => {
    const name = $('ofPlaylistName').value.trim(); if (!name) return status('Name the playlist first.', true);
    workspace.playlists.push({id: uid(), name, cursor: -1, items: []}); save(); renderLists(); $('ofPlaylist').value = workspace.playlists[workspace.playlists.length - 1].id;
  };
  $('ofPlaylist').onchange = renderLists;
  $('ofAddPlaylist').onclick = () => {
    const p = workspace.playlists.find(x => x.id === $('ofPlaylist').value); if (!p) return status('Create a playlist first.', true);
    p.items.push({title: $('ofBookmarkTitle').value.trim() || playFor('a')?.description || 'Moment', state: snapshot()}); save(); renderLists();
  };
  $('ofNextPlaylist').onclick = () => {
    const p = workspace.playlists.find(x => x.id === $('ofPlaylist').value); if (!p?.items.length) return status('Add moments to the playlist first.', true);
    p.cursor = ((Number(p.cursor) || 0) + 1) % p.items.length; restore(p.items[p.cursor].state); save();
  };
  $('ofSaveFilters').onclick = () => { workspace.presets.push({name: $('ofFilterName').value.trim() || 'Saved filters', filters: snapshot().filters}); save(); renderLists(); };
  $('ofApplyFilters').onclick = () => { const p = workspace.presets[Number($('ofFilterPreset').value)]; if (p) restore({...snapshot(), filters: p.filters}); };

  function pointFromEvent(board, event) {
    const rect = board.canvas.getBoundingClientRect(), tr = board.transform;
    if (!tr?.X || !tr?.Y) return null;
    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    return [(px - tr.X(0)) / (tr.X(1) - tr.X(0)), (py - tr.Y(0)) / (tr.Y(1) - tr.Y(0))];
  }
  function bindDrawing() {
    const boards = app.getBoards?.() || app.state.boards || {};
    for (const [key, board] of Object.entries(boards)) {
      if (!board.canvas || attachedCanvases.has(board.canvas)) continue;
      attachedCanvases.add(board.canvas);
      board.canvas.addEventListener('pointerdown', event => {
        if ($('ofDrawTool').value === 'off') return;
        const point = pointFromEvent(board, event), p = playFor(key); if (!point || !p) return;
        event.preventDefault(); event.stopImmediatePropagation(); app.pause();
        annotationDraft = {id: uid(), playId: p.id, key, time: effectiveTime(key), type: $('ofDrawTool').value, points: [point, point], text: $('ofDrawText').value.trim(), receiverId: snapshot().receivers?.[key]};
        board.canvas.setPointerCapture(event.pointerId);
      }, true);
      board.canvas.addEventListener('pointermove', event => {
        if (!annotationDraft || annotationDraft.key !== key) return;
        event.preventDefault(); event.stopImmediatePropagation(); const p = pointFromEvent(board, event); if (p) annotationDraft.points[1] = p; app.render();
      }, true);
      board.canvas.addEventListener('pointerup', event => {
        if (!annotationDraft || annotationDraft.key !== key) return;
        event.preventDefault(); event.stopImmediatePropagation(); const p = pointFromEvent(board, event); if (p) annotationDraft.points[1] = p;
        workspace.annotations.push(annotationDraft); annotationDraft = null; save(); app.render(); status('Drawing saved at this frame.');
      }, true);
      board.canvas.addEventListener('pointercancel', () => { annotationDraft = null; app.render(); }, true);
      board.canvas.addEventListener('click', event => { if ($('ofDrawTool').value !== 'off') { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    }
  }
  document.addEventListener('openfield:draw', event => {
    const {ctx, transform: tr, key, play, frame, preSnap, observedTime} = event.detail || {};
    if (!ctx || !tr?.X || !play) return;
    const time = Number.isFinite(observedTime) ? observedTime : preSnap ? effectiveTime(key) : play.times[frame];
    const annotations = workspace.annotations.concat(annotationDraft ? [annotationDraft] : []).filter(a => a.playId === play.id && (a.time < 0) === (time < 0) && Math.abs(a.time - time) < 0.051);
    ctx.save(); ctx.strokeStyle = '#ffe18c'; ctx.fillStyle = '#ffe18c'; ctx.lineWidth = 3;
    for (const a of annotations) {
      const [p, q] = a.points, x = tr.X(p[0]), y = tr.Y(p[1]), u = tr.X(q[0]), v = tr.Y(q[1]);
      ctx.beginPath();
      if (a.type === 'circle') { ctx.ellipse((x + u) / 2, (y + v) / 2, Math.max(5, Math.abs(u - x) / 2), Math.max(5, Math.abs(v - y) / 2), 0, 0, Math.PI * 2); ctx.stroke(); }
      if (a.type === 'arrow') {
        ctx.moveTo(x, y); ctx.lineTo(u, v); ctx.stroke(); const angle = Math.atan2(v - y, u - x);
        ctx.beginPath(); ctx.moveTo(u, v); ctx.lineTo(u - 11 * Math.cos(angle - 0.4), v - 11 * Math.sin(angle - 0.4)); ctx.lineTo(u - 11 * Math.cos(angle + 0.4), v - 11 * Math.sin(angle + 0.4)); ctx.closePath(); ctx.fill();
      }
      if (a.text) { ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(a.text.slice(0, 120), x + 6, y - 8); }
    }
    ctx.restore();
  });
  $('ofUndoDraw').onclick = () => { const id = playFor($('ofNoteBoard').value)?.id; const index = workspace.annotations.map(a => a.playId).lastIndexOf(id); if (index >= 0) workspace.annotations.splice(index, 1); save(); app.render(); };
  $('ofClearDraw').onclick = () => { const id = playFor($('ofNoteBoard').value)?.id; workspace.annotations = workspace.annotations.filter(a => a.playId !== id); save(); app.render(); };

  function datasetIdentity() {
    const m = app.data.meta || {};
    return {season: m.season, sourceRevision: m.sourceRevision, build: m.build || m.buildId || null, sha256: m.datasetSha256 || null, playCount: app.data.plays.length, application: m.application || null};
  }
  function requireDataset(identity) {
    if (!identity) throw new Error('The saved finding has no dataset identity.');
    const current = datasetIdentity();
    if (identity.season !== current.season || identity.sourceRevision !== current.sourceRevision || identity.build !== current.build || identity.playCount !== current.playCount || identity.sha256 !== current.sha256) {
      throw new Error('Load the exact game pack used by this finding before restoring it.');
    }
  }
  function selectedRows() {
    const s = snapshot(), rows = [];
    for (const key of ['a', 'b']) {
      const p = playFor(key); if (!p) continue;
      for (const r of p.players.filter(q => q.role === 'route' && q.side === 'offense')) {
        for (const row of OFMetrics.series(p, r.id, {...options(s), ...(s.ui?.blind ? {throughTime: effectiveTime(key)} : {})})) {
          rows.push({board: key.toUpperCase(), playId: p.id, receiverId: r.id, receiverName: r.name, scope: s.metricOptions.scope, lookback: s.metricOptions.lookback, threshold: s.metricOptions.threshold, minDuration: s.metricOptions.minDuration, downfieldOnly: s.metricOptions.downfieldOnly, inBoundsOnly: s.metricOptions.inBoundsOnly, ...row});
        }
      }
    }
    return rows;
  }
  function csvCell(value) {
    let text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
    if (/^[=+@\t\r]/.test(text) || (/^-/.test(text) && !Number.isFinite(Number(text)))) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  $('ofExportCSV').onclick = () => {
    const rows = selectedRows(), fields = ['board', 'playId', 'receiverId', 'receiverName', 'time', 'eligible', 'distance', 'nearestId', 'secondDistance', 'within3', 'within5', 'coverage', 'receiver', 'gain', 'closingRate', 'reason', 'scope', 'lookback', 'threshold', 'minDuration', 'downfieldOnly', 'inBoundsOnly'];
    const lines = [fields.join(','), ...rows.map(row => fields.map(key => csvCell(row[key])).join(','))];
    download(new Blob(['\ufeff' + lines.join('\r\n')], {type: 'text/csv;charset=utf-8'}), filename('metrics.csv')); status('Full-precision measurements exported with eligibility and scope.');
  };
  function wrap(ctx, text, x, y, width, lineHeight = 20, maxLines = 4) {
    const words = String(text || '').split(/\s+/); let line = '', count = 0;
    for (const word of words) {
      const next = line ? line + ' ' + word : word;
      if (ctx.measureText(next).width > width && line) { ctx.fillText(line, x, y + count * lineHeight); if (++count >= maxLines) return y + count * lineHeight; line = word; }
      else line = next;
    }
    if (line) ctx.fillText(line, x, y + count++ * lineHeight);
    return y + count * lineHeight;
  }
  function renderEvidenceCanvas() {
    if (app.getPreSnap?.()) throw new Error('Return to the snap before exporting an analytical finding; pre-snap metrics are paused.');
    const s = snapshot(), keys = s.b ? ['a', 'b'] : ['a'];
    const boardSeries = Object.fromEntries(keys.map(key => [key, OFMetrics.series(playFor(key), s.receivers[key], options(s, key))]));
    const amplitude = Math.max(1, ...Object.values(boardSeries).flat().filter(r => r.valid).map(r => Math.max(Math.abs(r.coverage), Math.abs(r.receiver))));
    const chartDuration = s.ui?.blind ? Math.max(10, Math.ceil(s.t)) : app.getDuration?.() || Math.max(...keys.map(key => playFor(key).times.at(-1)));
    const canvas = document.createElement('canvas'); canvas.width = 2000; canvas.height = 1500;
    const c = canvas.getContext('2d'), pad = 54, gap = 28, width = (canvas.width - 2 * pad - gap * (keys.length - 1)) / keys.length;
    c.fillStyle = '#f5f5ef'; c.fillRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = '#182c2d'; c.font = 'bold 38px sans-serif'; c.fillText('Open Field / Coverage Lift', pad, 62);
    c.font = '22px sans-serif'; wrap(c, $('ofExportTitle').value || 'Where did the opening come from?', pad, 100, canvas.width - 2 * pad, 26, 2);
    c.font = '16px sans-serif'; c.fillStyle = '#526b62';
    wrap(c, `View ${viewId(s)} · ${s.mode} · ${s.alignment || 'snap'} alignment · Lookback ${s.metricOptions?.lookback ?? 0.5}s · Threshold ${s.metricOptions?.threshold ?? 3} yd · ${s.metricOptions?.scope || 'coverage'} defenders · ${s.metricOptions?.downfieldOnly ? 'downfield' : 'whole route'} · ${s.metricOptions?.inBoundsOnly ? 'in bounds' : 'boundary flags retained'}`, pad, 151, canvas.width - 2 * pad, 23, 2);
    keys.forEach((key, index) => {
      const p = playFor(key); if (!p) return;
      const x = pad + index * (width + gap), t = effectiveTime(key), frame = OFMetrics.frameAt(p, t), receiver = p.players.find(q => q.id === s.receivers[key]);
      const lift = receiver ? OFMetrics.coverageLift(p, receiver.id, frame, options(s, key)) : null;
      c.fillStyle = '#182c2d'; c.font = 'bold 23px sans-serif'; c.fillText(`${key.toUpperCase()} · ${p.offense} vs ${p.defense} · ${fmt(t, 1)}s`, x, 208);
      c.font = '16px sans-serif'; wrap(c, `${p.id} · ${receiver?.name || 'No receiver'} · ${p.coverage || 'Unknown coverage'}`, x, 239, width, 20, 2);
      const field = document.createElement('canvas'); field.width = Math.round(width); field.height = 620;
      if (typeof app.renderField !== 'function') throw new Error('Native field export is not available in this build.');
      app.renderField(key, field, {width: field.width, height: field.height, exporting: true});
      c.drawImage(field, x, 278);
      if (s.ui?.baseline) {
        c.fillStyle = '#182c2d'; c.font = '22px sans-serif'; c.fillText('Ordinary replay · analytical overlays hidden', x, 936);
      } else {
      c.fillStyle = '#182c2d'; c.font = 'bold 23px sans-serif';
      c.fillText(`Coverage Lift ${signed(lift?.coverage)} yd`, x, 936);
      c.font = '18px sans-serif'; c.fillText(`Receiver movement ${signed(lift?.receiver)} yd · Net ${signed(lift?.gain)} yd`, x, 965);
      if (!lift?.valid) { c.font = '16px sans-serif'; wrap(c, lift?.reason || 'Full lookback history required.', x, 992, width, 19, 2); }
      const rows = receiver ? boardSeries[key] : [];
      const chart = {x: x + 35, y: 1020, w: width - 52, h: 160};
      c.strokeStyle = '#b8c9be'; c.lineWidth = 1; c.strokeRect(chart.x, chart.y, chart.w, chart.h);
      const clockOffset = app.getTimeOffset?.(key) || 0;
      const X = value => chart.x + (value - clockOffset) / Math.max(0.1, chartDuration) * chart.w, Y = value => chart.y + chart.h / 2 - value / amplitude * (chart.h / 2 - 8);
      c.strokeStyle = '#b8c9be'; c.beginPath(); c.moveTo(chart.x, Y(0)); c.lineTo(chart.x + chart.w, Y(0)); c.stroke();
      c.save(); c.beginPath(); c.rect(chart.x, chart.y, chart.w, chart.h); c.clip();
      for (const [fieldName, color] of [['coverage', '#176d58'], ['receiver', '#aa6231']]) {
        c.beginPath(); let start = true; for (const row of rows) { if (!row.valid) { start = true; continue; } if (start) c.moveTo(X(row.time), Y(row[fieldName])); else c.lineTo(X(row.time), Y(row[fieldName])); start = false; } c.strokeStyle = color; c.lineWidth = 2.5; c.stroke();
      }
      c.strokeStyle = '#172f2d'; c.beginPath(); c.moveTo(X(t), chart.y); c.lineTo(X(t), chart.y + chart.h); c.stroke();
      c.restore();
      c.fillStyle = '#526b62'; c.font = '14px sans-serif'; c.fillText(`Signed contribution ±${fmt(amplitude, 1)} yd · green: coverage · orange: receiver`, x, 1205);
      c.fillText(`Aligned clock: 0 to ${fmt(chartDuration, 1)} s · shared scales`, x, 1226);
      }
      const notes = (workspace.notes[p.id] || []).filter(n => Math.abs(n.time - t) <= 0.6 && (!s.ui?.blind || n.time <= t));
      c.font = '17px sans-serif'; c.fillStyle = '#182c2d'; wrap(c, notes.map(n => n.text).join(' / ') || (!s.ui?.blind && workspace.labels[p.id]) || 'No coach annotation at this moment.', x, 1260, width, 22, 4);
    });
    c.font = '16px sans-serif'; c.fillStyle = '#526b62';
    wrap(c, `${app.data.meta.season} observed tracking · source ${String(app.data.meta.sourceRevision).slice(0, 12)} · app ${app.data.meta.application?.version || '2.0.0'} · metric engine ${OFMetrics.version}`, pad, 1400, canvas.width - 2 * pad, 21, 2);
    wrap(c, 'Coverage movement is a geometric contribution, not causal teammate credit or catch probability. Observations stop at the recorded endpoint. Full analysis state is available in the workspace export.', pad, 1440, canvas.width - 2 * pad, 21, 2);
    return canvas;
  }
  async function exportPNG() {
    try { app.pause(); const canvas = renderEvidenceCanvas(); const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); if (!blob) throw new Error('Image encoder returned no data.'); download(blob, filename('png')); status('Native-resolution evidence image exported.'); }
    catch (error) { status(error.message, true); }
  }
  $('ofExportPNG').onclick = exportPNG;
  $('ofExportReport').onclick = () => {
    try {
      const s = snapshot(), evidence = renderEvidenceCanvas().toDataURL('image/png');
      const notes = ['a', 'b'].map(key => { const p = playFor(key); return p ? `<h2>${esc(p.offense)} vs ${esc(p.defense)} / ${esc(p.id)}</h2><ul>${(workspace.notes[p.id] || []).filter(n => !s.ui?.blind || n.time <= effectiveTime(key)).map(n => `<li><b>${fmt(n.time, 1)}s</b> ${esc(n.text)}</li>`).join('')}</ul>` : ''; }).join('');
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Open Field finding</title><style>body{max-width:1200px;margin:30px auto;padding:20px;font:16px/1.5 sans-serif;color:#182c2d;background:#f5f5ef}img{width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>${esc($('ofExportTitle').value || 'Open Field coaching finding')}</h1><img alt="Field replay, signed Coverage Lift and receiver-movement measurements" src="${evidence}">${notes}<details><summary>Exact analysis and provenance</summary><pre>${esc(JSON.stringify({dataset: datasetIdentity(), snapshot: s}, null, 2))}</pre></details><p>Experimental geometric metric. No participant validation or causal route attribution is claimed.</p></html>`;
      download(new Blob([html], {type: 'text/html;charset=utf-8'}), filename('report.html')); status('Annotated coaching report exported.');
    } catch (error) { status(error.message, true); }
  };
  async function recordClip() {
    if (recorder) return;
    if (app.getPreSnap?.()) return status('Return to the snap before exporting an analytical replay clip.', true);
    const s = snapshot(), start = Number($('ofClipStart').value), end = Number($('ofClipEnd').value);
    const max = app.getDuration?.() || Math.max(...['a', 'b'].map(key => playFor(key)?.times.at(-1) || 0));
    if (!(start >= 0 && end > start && end <= max && end - start <= 30)) return status('Choose an observed interval up to 30 seconds long.', true);
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return status('This browser cannot encode replay video. Use an up-to-date Chromium browser, or export the annotated report.', true);
    app.pause(); app.seek(start); const canvas = renderEvidenceCanvas(), ctx = canvas.getContext('2d'), stream = canvas.captureStream(15), chunks = [];
    const captureTrack = stream.getVideoTracks()[0];
    const mime = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    try {
      recorder = new MediaRecorder(stream, mime ? {mimeType: mime} : {});
      const completed = new Promise(resolve => recorder.onstop = resolve);
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = event => { recordingStopped = true; status(event.error?.message || 'Video recording failed.', true); };
      $('ofStopRecording').disabled = false; $('ofRecordClip').disabled = true; recordingStopped = false;
      const started = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Video encoder did not start. Try another supported browser.')), 5000);
        recorder.onstart = () => { clearTimeout(timer); resolve(); };
        recorder.onerror = event => { clearTimeout(timer); recordingStopped = true; reject(new Error(event.error?.message || 'Video recording failed.')); };
      }); recorder.start(100); await started;
      captureTrack.requestFrame?.();
      const begin = performance.now();
      await new Promise(resolve => {
        const tick = now => {
          const time = Math.min(end, start + (now - begin) / 1000); app.seek(time);
          const frame = renderEvidenceCanvas(); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(frame, 0, 0);
          captureTrack.requestFrame?.();
          status(`Recording ${fmt(time - start, 1)} / ${fmt(end - start, 1)} seconds…`);
          if (time >= end || recordingStopped) resolve(); else setTimeout(() => requestAnimationFrame(tick), 60);
        }; requestAnimationFrame(tick);
      });
      // Give the encoder a final captured frame before flushing its chunks.
      await new Promise(resolve => setTimeout(resolve, 200));
      if (recorder.state !== 'inactive') recorder.stop(); await completed;
      const blob = new Blob(chunks, {type: mime || 'video/webm'});
      if (!blob.size) throw new Error('Video encoder returned no frames.');
      download(blob, filename('webm')); status('Replay clip exported with metric context and annotations.');
    } catch (error) { status(error.message, true); }
    finally { if (recorder?.state !== 'inactive') { try { recorder.stop(); } catch (_) {} } stream.getTracks().forEach(track => track.stop()); recorder = null; $('ofStopRecording').disabled = true; $('ofRecordClip').disabled = false; app.setSnapshot(s); }
  }
  $('ofRecordClip').onclick = recordClip;
  $('ofStopRecording').onclick = () => { recordingStopped = true; };

  async function readJSON(file) {
    if (!file) throw new Error('No file selected.');
    if (file.size > 80 * 1024 * 1024) throw new Error('Choose a game pack or workspace smaller than 80 MB.');
    try { return JSON.parse(await file.text()); } catch (_) { throw new Error('The file is not valid JSON.'); }
  }
  function validatePack(data) {
    if (!window.OFSchema) throw new Error('The dataset validator is unavailable; reopen the complete application export.');
    return window.OFSchema.validateDataset(data);
  }
  $('ofImportPack').onchange = async event => {
    try {
      const file = event.target.files[0], data = validatePack(await readJSON(file));
      const digest = globalThis.crypto?.subtle ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('') : null;
      const known = trustedPacks.some(pack => pack.sha256 === digest && pack.buildId === data.meta.buildId);
      const context = verifiedContext;
      data.meta.trustedGamePacks = trustedPacks;
      data.meta.datasetSha256 = digest;
      if (!known) {
        data.meta.sourceVerification = 'unverified_import';
        data.meta.requestedSourceRevision = data.meta.sourceRevision || data.meta.requestedSourceRevision || null;
        data.meta.sourceRevision = null;
        data.meta.note = 'Imported observations passed schema and geometry checks; source revision and external outcomes are not verified for these file bytes.';
        delete data.meta.outcomeContext;
        data.plays.forEach(play => { delete play.outcomeContext; });
      }
      if (known && context && data.meta.season === 2021) {
        for (const play of data.plays) {
          const joined = context.playIndex?.[play.id];
          if (joined && (!joined.targetId || play.players.some(p => p.id === joined.targetId && p.side === 'offense'))) play.outcomeContext = joined;
        }
        data.meta.outcomeContext = context;
      }
      save(); memoryWorkspaces.set(storageKey, workspace);
      storageKey = storageIdentity(data); workspace = memoryWorkspaces.get(storageKey) || emptyWorkspace();
      if (!memoryWorkspaces.has(storageKey)) {
        try { const stored = JSON.parse(localStorage.getItem(storageKey) || 'null'); if (stored) workspace = validateWorkspace(stored); }
        catch (_) { storageAvailable = false; }
      }
      memoryNotes.clear(); lastPlayIds = ''; annotationDraft = null;
      app.pause(); app.loadDataset(data); renderLists(); updateContext(); status(`${data.plays.length} plays loaded. ${known ? 'Source file checksum verified.' : 'Geometry validated; source file identity unverified.'}`);
    }
    catch (error) { status(error.message, true); }
    event.target.value = '';
  };
  $('ofBlind').onchange = () => restore({...snapshot(), ui: {...snapshot().ui, blind: $('ofBlind').checked}});
  $('ofBaseline').onchange = () => restore({...snapshot(), ui: {...snapshot().ui, baseline: $('ofBaseline').checked}});
  $('ofPractice').onclick = () => {
    const eligible = app.data.plays.filter(p => !p.penalty?.nullified && p.times.at(-1) >= 1.5);
    if (!eligible.length) return status('This pack has no suitable observed practice interval.', true);
    const p = eligible[Math.floor(Math.random() * eligible.length)];
    const initial = snapshot(); initial.ui = {...initial.ui, blind: true}; initial.receivers = {a: null, b: null}; app.setSnapshot(initial);
    app.selectPlay('a', p.id); const s = snapshot();
    s.b = null; s.t = Math.min(2, p.times.at(-1) - 0.5); s.ui = {...s.ui, blind: true}; app.setSnapshot(s); $('ofBlind').checked = true; $('ofPracticeRead').value = ''; status('Describe the observed space before revealing the continuation.');
  };
  $('ofReveal').onclick = () => {
    const s = snapshot(); workspace.exercises.push({id: uid(), state: s, response: $('ofPracticeRead').value, measuredAt: new Date().toISOString(), grade: null}); save();
    s.ui = {...s.ui, blind: false}; app.setSnapshot(s); $('ofBlind').checked = false; status('Continuation revealed. Your observation is stored without an automatic grade.');
  };
  function updateContext() {
    const s = snapshot(), ids = `${s.a}|${s.b}|${$('ofNoteBoard').value}`;
    if (ids !== lastPlayIds) { lastPlayIds = ids; $('ofNoteText').value = memoryNotes.get(activeNoteId()) || ''; renderNotes(); }
    if (s.ui?.blind) renderNotes();
    const p = playFor($('ofNoteBoard').value), receiver = p?.players.find(q => q.id === s.receivers?.[$('ofNoteBoard').value]);
    if (p) $('ofNoteContext').textContent = `${p.offense} vs ${p.defense} · ${p.id} · ${fmt(effectiveTime($('ofNoteBoard').value), 1)}s · ${receiver?.name || ''}`;
    $('ofPackContext').textContent = `${app.data.plays.length} plays · ${new Set(app.data.plays.map(p => p.gameId)).size} games · ${app.data.meta.season} season. Import packs built with tools/build_packs.py.`;
    $('ofBlind').checked = Boolean(s.ui?.blind); $('ofBaseline').checked = Boolean(s.ui?.baseline);
    bindDrawing();
  }
  document.addEventListener('openfield:change', updateContext);
  renderLists(); updateContext();
  if (location.hash.startsWith('#view=')) {
    try { const value = decodeFragment(location.hash.slice(6)); requireDataset(value.dataset); restore(value.snapshot); }
    catch (error) { status('The replay link could not be restored: ' + error.message, true); }
  }
  window.OpenFieldWorkspace = {get workspace() { return workspace; }, validatePack, validateWorkspace, renderEvidenceCanvas, selectedRows, exportPNG, recordClip, snapshot, restore, status};
})();
