/* Dataset identity, pack trust, negative-frame drawings and blind exports.
 * Run after python app.py --export submission/Open-Field.html:
 *   node tests/workspace_integrity.cjs submission [--firefox]
 * Uses real file inputs and downloads; never changes source datasets.
 */
const playwright = require(process.env.OPEN_FIELD_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'submission'));
const QA = path.join(OUT, 'qa');
const firefox = process.argv.includes('--firefox');
const checks = [];
const sourceBytes = fs.readFileSync(path.join(ROOT, 'data/demo.json'));
const source = JSON.parse(sourceBytes);
const extraBytes = fs.readFileSync(path.join(ROOT, 'data/packs/week-1-additional/demo.json'));
const extra = JSON.parse(extraBytes);
const PLAY = '2021110100_2120';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

(async () => {
  fs.mkdirSync(QA, {recursive: true});
  const browser = await (firefox ? playwright.firefox : playwright.chromium).launch({
    headless: true,
    ...(!firefox && process.env.OPEN_FIELD_BROWSER ? {executablePath: process.env.OPEN_FIELD_BROWSER} : {})
  });
  try {
    const context = await browser.newContext({viewport: {width: 1440, height: 1080}, acceptDownloads: true});
    // Capture actual painted text, including native-resolution export canvases.
    await context.addInitScript(() => {
      const original = CanvasRenderingContext2D.prototype.fillText;
      window.__paintedText = [];
      CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
        window.__paintedText.push(String(text));
        return original.call(this, text, ...args);
      };
    });
    const page = await context.newPage(), errors = [], external = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
    await page.goto(pathToFileURL(path.join(OUT, 'Open-Field.html')).href);
    await page.waitForFunction(() => window.OpenFieldWorkspace && window.OpenFieldApp);

    const review = () => page.locator('[data-tab="review"]').click();
    async function selectPlay(time = 1) {
      await page.evaluate(({id, time}) => {
        OpenFieldApp.selectPlay('a', id);
        const s = OpenFieldApp.getSnapshot();
        s.b = null; s.t = time; s.ui = {...s.ui, blind: false, baseline: false, tab: 'review'};
        OpenFieldApp.setSnapshot(s);
      }, {id: PLAY, time});
      await review();
      await page.locator('#ofNoteBoard').selectOption('a');
    }
    async function note(text, time) {
      await page.evaluate(time => OpenFieldApp.seek(time), time);
      await review();
      await page.locator('#ofNoteText').fill(text);
      await page.locator('#ofSaveNote').click();
      await page.waitForFunction(text => document.querySelector('#ofNoteList').textContent.includes(text), text);
    }
    async function importPack(bytes, name) {
      await review();
      await page.evaluate(() => { document.querySelector('#ofWorkspaceStatus').textContent = ''; });
      await page.locator('#ofImportPack').setInputFiles({name, mimeType: 'application/json', buffer: bytes});
      await page.waitForFunction(() => /plays loaded|failed|invalid|cannot|error/i.test(document.querySelector('#ofWorkspaceStatus').textContent), null, {timeout: 30000});
      assert.notEqual(await page.locator('#ofWorkspaceStatus').getAttribute('data-error'), 'true', await page.locator('#ofWorkspaceStatus').innerText());
    }
    async function download(selector, name) {
      const pending = page.waitForEvent('download', {timeout: 30000});
      await page.locator(selector).click();
      const result = await pending;
      const destination = path.join(QA, name);
      await result.saveAs(destination);
      return destination;
    }

    // A trusted pack is accepted because its exact bytes are registered, not
    // because its JSON contains an impressive-looking revision or status.
    assert(await page.evaluate(expected => OpenFieldApp.data.meta.trustedGamePacks.some(p => p.sha256 === expected), sha(extraBytes)), 'Export must register the additional pack SHA-256');
    await importPack(extraBytes, 'additional-pack.json');
    assert.equal(await page.evaluate(() => OpenFieldApp.data.plays.length), extra.plays.length);
    assert.equal(await page.evaluate(() => OpenFieldApp.data.meta.sourceVerification), 'verified_manifest');
    assert(await page.evaluate(() => OpenFieldApp.data.plays.some(p => !!p.outcomeContext)), 'Known pack should receive its validated outcome join');
    checks.push('Exact known-pack bytes retain verified source identity and external outcome context');

    await importPack(sourceBytes, 'original-pack.json');
    await selectPlay();
    const originalNote = 'ORIGINAL_DATASET_OBSERVATION';
    await note(originalNote, 1);
    await page.locator('#ofBookmarkTitle').fill('Original dataset bookmark');
    await page.locator('#ofSaveBookmark').click();
    const savedPath = await download('#ofExportSession', 'integrity-original-workspace.json');
    const savedWorkspace = JSON.parse(fs.readFileSync(savedPath, 'utf8'));

    // Keep valid football geometry and the same IDs/build claim; change real
    // source metadata, so a checksum rather than a declaration must distinguish it.
    const edited = structuredClone(source);
    edited.plays.find(p => p.id === PLAY).context.homeScore += 1;
    edited.meta.sourceVerification = 'verified_manifest';
    edited.plays.find(p => p.id === PLAY).outcomeContext = {targetId: '44835', targetName: 'FORGED_CONTEXT'};
    edited.meta.outcomeContext = {playIndex: {[PLAY]: {targetName: 'FORGED_CONTEXT'}}, sha256: 'fake'};
    const editedBytes = Buffer.from(JSON.stringify(edited));
    assert.notEqual(sha(editedBytes), sha(sourceBytes));
    await importPack(editedBytes, 'edited-same-ids.json');
    await selectPlay();
    const imported = await page.evaluate(() => ({
      verification: OpenFieldApp.data.meta.sourceVerification,
      revision: OpenFieldApp.data.meta.sourceRevision,
      outcomes: OpenFieldApp.data.plays.filter(p => p.outcomeContext).length,
      metadataOutcome: !!OpenFieldApp.data.meta.outcomeContext
    }));
    assert.notEqual(imported.verification, 'verified_manifest');
    assert.equal(imported.revision, null);
    assert.equal(imported.outcomes, 0, 'Edited bytes must not retain forged or inherited target/EPA context');
    assert.equal(imported.metadataOutcome, false);
    assert(!((await page.locator('#ofNoteList').innerText()).includes(originalNote)), 'Changed dataset with identical play IDs must not inherit notes');
    assert(!((await page.locator('#ofBookmarkList').innerText()).includes('Original dataset bookmark')), 'Changed dataset must not inherit bookmarks');
    checks.push('Self-declared verified metadata cannot confer source trust or preserve forged outcome context');
    checks.push('Changed dataset bytes with identical play IDs have a separate note and bookmark workspace');

    const beforeMismatch = await page.evaluate(() => ({snapshot: OpenFieldApp.getSnapshot(), workspace: structuredClone(OpenFieldWorkspace.workspace)}));
    await page.locator('#ofImportSession').setInputFiles({name: 'wrong-dataset-workspace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(savedWorkspace))});
    await page.waitForFunction(() => document.querySelector('#ofWorkspaceStatus').dataset.error === 'true');
    assert.match(await page.locator('#ofWorkspaceStatus').innerText(), /exact|matching|dataset|pack/i);
    const afterMismatch = await page.evaluate(() => ({snapshot: OpenFieldApp.getSnapshot(), workspace: structuredClone(OpenFieldWorkspace.workspace)}));
    assert.deepEqual(afterMismatch, beforeMismatch, 'Rejected workspace must leave active state and notes unchanged');
    checks.push('Exact dataset mismatch rejects a workspace before state or notes change');

    await note('EDITED_DATASET_OBSERVATION', 1);
    await importPack(sourceBytes, 'original-pack-again.json');
    await selectPlay();
    assert((await page.locator('#ofNoteList').innerText()).includes(originalNote), 'Returning to original bytes should restore its workspace');
    assert(!((await page.locator('#ofNoteList').innerText()).includes('EDITED_DATASET_OBSERVATION')));
    checks.push('Switching back restores only the original dataset workspace');

    // A real UI drawing is placed at a negative source frame, then the paint
    // interceptor proves it appears only in that pre-snap observation.
    await page.locator('#ofDrawTool').selectOption('text');
    await page.locator('#ofDrawText').fill('PRESNAP_ONLY_MARKER');
    await page.evaluate(() => {
      const s = OpenFieldApp.getSnapshot(), p = OpenFieldApp.getPlay('a');
      const index = p.preSnap.times.findIndex(t => t <= -.3);
      if (index < 0) throw new Error('Fixture needs a pre-snap observation at least .3s before snap');
      s.preSnap = {key: 'a', index}; s.ui.tab = 'replay'; OpenFieldApp.setSnapshot(s);
    });
    const field = page.locator('.field-canvas').first();
    const box = await field.boundingBox(); assert(box);
    await page.mouse.move(box.x + box.width * .4, box.y + box.height * .4);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5); await page.mouse.up();
    assert(await page.evaluate(() => OpenFieldWorkspace.workspace.annotations.some(a => a.text === 'PRESNAP_ONLY_MARKER' && a.time < 0)));
    const atNegative = await page.evaluate(() => { window.__paintedText = []; OpenFieldApp.render(); return window.__paintedText.includes('PRESNAP_ONLY_MARKER'); });
    assert(atNegative, 'Negative-frame annotation must be painted on its observed pre-snap frame');
    const atSnap = await page.evaluate(() => { window.__paintedText = []; OpenFieldApp.seek(0); return window.__paintedText.includes('PRESNAP_ONLY_MARKER'); });
    assert.equal(atSnap, false, 'Pre-snap annotation must not leak onto snap');
    checks.push('Pre-snap annotation paints at its negative frame and stays absent after snap');
    await review(); await page.locator('#ofDrawTool').selectOption('off');

    await note('EARLY_VISIBLE_OBSERVATION', .7);
    await note('FUTURE_HIDDEN_OBSERVATION', 1.5);
    await page.evaluate(() => { const s = OpenFieldApp.getSnapshot(); s.t = 1; s.ui.blind = true; s.ui.tab = 'review'; OpenFieldApp.setSnapshot(s); });
    await review();
    const visibleNotes = await page.locator('#ofNoteList').innerText();
    assert(visibleNotes.includes('EARLY_VISIBLE_OBSERVATION'));
    assert(!visibleNotes.includes('FUTURE_HIDDEN_OBSERVATION'), 'Blind note list must stop at the observed cutoff');
    const painted = await page.evaluate(() => { window.__paintedText = []; OpenFieldWorkspace.renderEvidenceCanvas(); return window.__paintedText.join('\n'); });
    assert(painted.includes('EARLY_VISIBLE_OBSERVATION'));
    assert(!painted.includes('FUTURE_HIDDEN_OBSERVATION'), 'The export proximity window must not expose a future note');
    const reportPath = await download('#ofExportReport', 'integrity-blind-report.html');
    const report = fs.readFileSync(reportPath, 'utf8');
    assert(report.includes('EARLY_VISIBLE_OBSERVATION'));
    assert(!report.includes('FUTURE_HIDDEN_OBSERVATION'), 'Blind HTML report must not contain future note text');
    checks.push('Blind on-screen notes, evidence canvas and exported report all exclude future notes');

    assert.deepEqual(errors, [], 'No JavaScript runtime errors');
    assert.deepEqual(external, [], 'Integrity verification remains offline');
    const result = {status: 'passed', browser: firefox ? 'firefox' : 'chromium', checks,
      datasetSha256: sha(sourceBytes), additionalPackSha256: sha(extraBytes),
      htmlSha256: sha(fs.readFileSync(path.join(OUT, 'Open-Field.html'))),
      javascriptErrors: errors, externalRequests: external};
    fs.writeFileSync(path.join(QA, `workspace-integrity-${result.browser}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
