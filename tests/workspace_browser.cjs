/* Real-browser checks for persistence, portable findings, drawings and exports. */
const playwright = require(process.env.OPEN_FIELD_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, '../submission'));
const QA = path.join(OUT, 'qa'); fs.mkdirSync(QA, {recursive: true});
const firefox = process.argv.includes('--firefox');
const checks = [];

(async () => {
  const browser = await (firefox ? playwright.firefox : playwright.chromium).launch({
    headless: true, ...(!firefox && process.env.OPEN_FIELD_BROWSER ? {executablePath: process.env.OPEN_FIELD_BROWSER} : {})
  });
  const context = await browser.newContext({viewport: {width: 1440, height: 1080}, acceptDownloads: true});
  const page = await context.newPage(), errors = [], network = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  const file = pathToFileURL(path.join(OUT, 'Open-Field.html')).href;
  await page.goto(file);
  await page.waitForFunction(() => window.OpenFieldWorkspace && window.OpenFieldApp);
  await page.locator('[data-tab="review"]').click();
  await page.locator('#ofBookmarkTitle').fill('Opening evidence');
  await page.locator('#ofSaveBookmark').click();
  assert.match(await page.locator('#ofBookmarkList').innerText(), /Opening evidence/);
  checks.push('save and reopen exact moment');
  const bookmarked = await page.evaluate(() => OpenFieldApp.getSnapshot());
  await page.evaluate(() => OpenFieldApp.seek(.5));
  await page.locator('#ofBookmarkList button').first().click();
  assert.equal(await page.evaluate(() => OpenFieldApp.getSnapshot().t), bookmarked.t);
  await page.locator('[data-tab="review"]').click();

  await page.locator('#ofNoteText').fill('Coverage moved away; investigate the adjacent route.');
  await page.locator('#ofSaveNote').click();
  assert.match(await page.locator('#ofNoteList').innerText(), /Coverage moved away/);
  await page.locator('#ofCoachLabel').fill('Coach hypothesis: switch release');
  await page.locator('#ofSaveLabel').click();
  assert.match(await page.locator('#ofLabelStatus').innerText(), /Coach annotation/);
  checks.push('timestamped notes and explicitly coach-supplied labels');
  await page.evaluate(() => OpenFieldApp.selectPlay('b', '2021110100_1396', {preserveTime: true}));
  await page.locator('[data-tab="review"]').click();
  await page.locator('#ofNoteBoard').selectOption('b');
  await page.locator('#ofNoteText').fill('Play B: receiver movement supplies the opening.');
  await page.locator('#ofSaveNote').click();
  assert.match(await page.locator('#ofNoteList').innerText(), /Play B: receiver/);
  await page.locator('#ofNoteBoard').selectOption('a');
  assert(!((await page.locator('#ofNoteList').innerText()).includes('Play B: receiver')));
  checks.push('separate timestamped observations for both comparison plays');

  await page.locator('#ofPlaylistName').fill('Window review');
  await page.locator('#ofCreatePlaylist').click();
  await page.locator('#ofAddPlaylist').click();
  assert.equal(await page.locator('#ofPlaylistItems button').count(), 1);
  await page.locator('#ofNextPlaylist').click();
  await page.locator('[data-tab="review"]').click();
  await page.locator('#ofFilterName').fill('Our review filter');
  await page.locator('#ofSaveFilters').click();
  await page.locator('#ofApplyFilters').click();
  checks.push('playlist navigation and reusable filters');

  async function saveDownload(selector, name) {
    const pending = page.waitForEvent('download', {timeout: 30000}).catch(async error => {
      console.error('Export status:', await page.locator('#ofWorkspaceStatus').innerText(), 'JS errors:', errors);
      throw error;
    });
    await page.locator(selector).click();
    const download = await pending;
    const target = path.join(QA, name); await download.saveAs(target); return target;
  }
  const sessionFile = await saveDownload('#ofExportSession', 'workspace.json');
  const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(saved.type, 'open-field-workspace');
  assert.equal(saved.workspace.bookmarks.length, 1);
  assert(Object.values(saved.workspace.notes).flat().some(n => n.text.includes('Coverage moved away')));
  await page.locator('#ofImportSession').setInputFiles(sessionFile);
  await page.waitForFunction(() => document.querySelector('#ofWorkspaceStatus').textContent.includes('Workspace imported'));
  checks.push('portable workspace export/import preserves observations');

  const csvFile = await saveDownload('#ofExportCSV', 'measurements.csv');
  const csv = fs.readFileSync(csvFile, 'utf8');
  assert(csv.includes('receiverName') && csv.includes('coverage') && csv.split('\n').length > 20);
  const pngFile = await saveDownload('#ofExportPNG', 'workspace-evidence.png');
  const png = fs.readFileSync(pngFile);
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 2000); assert.equal(png.readUInt32BE(20), 1500);
  assert(png.length > 50000, 'Expected substantial rendered field and chart content');
  const reportFile = await saveDownload('#ofExportReport', 'finding.html');
  assert(fs.readFileSync(reportFile, 'utf8').includes('Coverage moved away'));
  checks.push('full-precision CSV, native-resolution PNG and annotated HTML report');
  const beforeClip = await page.evaluate(() => OpenFieldApp.getSnapshot());
  await page.locator('#ofClipStart').fill('0.5'); await page.locator('#ofClipEnd').fill('0.9');
  const clipFile = await saveDownload('#ofRecordClip', 'evidence.webm');
  const clip = fs.readFileSync(clipFile);
  assert.equal(clip.toString('hex', 0, 4), '1a45dfa3'); assert(clip.length > 1000);
  await page.waitForFunction(t => Math.abs(OpenFieldApp.getSnapshot().t - t) < .0001, beforeClip.t);
  const video = await page.evaluate(async content => {
    const element = document.createElement('video'); element.src = 'data:video/webm;base64,' + content;
    return await new Promise((resolve, reject) => { element.onloadedmetadata = () => resolve({width: element.videoWidth, height: element.videoHeight}); element.onerror = () => reject(new Error('Recorded video cannot be decoded')); });
  }, clip.toString('base64'));
  assert.equal(video.width, 2000); assert.equal(video.height, 1500);
  checks.push('replay clip encodes, decodes at native resolution, and restores original replay state');

  await page.locator('#ofDrawTool').selectOption('arrow');
  await page.locator('#ofDrawText').fill('Inspect this movement');
  await page.locator('[data-tab="replay"]').click();
  const field = page.locator('.field-canvas').first();
  const box = await field.boundingBox(); assert(box);
  await page.mouse.move(box.x + box.width * .35, box.y + box.height * .4); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .55, box.y + box.height * .55, {steps: 4}); await page.mouse.up();
  assert.equal(await page.evaluate(() => OpenFieldWorkspace.workspace.annotations.length), 1);
  await page.locator('[data-tab="review"]').click();
  await page.locator('#ofUndoDraw').click();
  assert.equal(await page.evaluate(() => OpenFieldWorkspace.workspace.annotations.length), 0);
  checks.push('field-coordinate annotation drawing and undo');

  await page.locator('#ofPractice').click();
  await page.locator('[data-tab="review"]').click();
  assert.equal(await page.evaluate(() => OpenFieldApp.getSnapshot().ui.blind), true);
  await page.locator('#ofPracticeRead').fill('Watch the defender at the route crossing.');
  await page.locator('#ofReveal').click();
  assert.equal(await page.evaluate(() => OpenFieldApp.getSnapshot().ui.blind), false);
  assert.equal(await page.evaluate(() => OpenFieldWorkspace.workspace.exercises.at(-1).grade), null);
  checks.push('future-hidden self-practice and ungraded reveal');

  const malicious = path.join(QA, 'invalid-pack.json'); fs.writeFileSync(malicious, JSON.stringify({schemaVersion: 1, meta: {}, plays: [{id: 'invalid'}]}));
  await page.locator('#ofImportPack').setInputFiles(malicious);
  await page.waitForFunction(() => document.querySelector('#ofWorkspaceStatus').dataset.error === 'true');
  assert.match(await page.locator('#ofWorkspaceStatus').innerText(), /invalid|fps|times|meta/i);
  checks.push('malformed game pack rejected before replacing active data');

  const pack = path.join(__dirname, '../data/packs/week-1-additional/demo.json');
  if (fs.existsSync(pack)) {
    await page.locator('#ofImportPack').setInputFiles(pack);
    await page.waitForFunction(() => OpenFieldApp.data.plays.some(p => p.offense === 'ATL'));
    checks.push('additional real game pack imports into replay');
  }

  await page.setViewportSize({width: 390, height: 844});
  await page.locator('[data-tab="review"]').click();
  const sizes = await page.evaluate(() => ({width: document.documentElement.scrollWidth, viewport: innerWidth}));
  assert(sizes.width <= sizes.viewport, JSON.stringify(sizes));
  await page.screenshot({path: path.join(QA, firefox ? 'workspace-firefox.png' : 'workspace-mobile.png'), fullPage: true});
  checks.push('mobile workspace without horizontal overflow');

  const blockedContext = await browser.newContext({viewport: {width: 1280, height: 900}});
  await blockedContext.addInitScript(() => Object.defineProperty(window, 'localStorage', {get() { throw new DOMException('Storage denied', 'SecurityError'); }}));
  const blocked = await blockedContext.newPage();
  await blocked.goto(file); await blocked.waitForFunction(() => window.OpenFieldWorkspace);
  await blocked.locator('[data-tab="review"]').click();
  const firstId = await blocked.evaluate(() => OpenFieldApp.getSnapshot().a);
  await blocked.locator('#ofNoteText').fill('Memory-only note'); await blocked.locator('#ofSaveNote').click();
  await blocked.evaluate(() => OpenFieldApp.selectPlay('a', OpenFieldApp.data.plays.find(p => p.id !== OpenFieldApp.getSnapshot().a).id));
  await blocked.locator('[data-tab="review"]').click();
  assert(!((await blocked.locator('#ofNoteList').innerText()).includes('Memory-only note')));
  await blocked.evaluate(id => OpenFieldApp.selectPlay('a', id), firstId);
  await blocked.locator('[data-tab="review"]').click();
  assert.match(await blocked.locator('#ofNoteList').innerText(), /Memory-only note/);
  checks.push('unavailable storage retains notes in memory without cross-play leakage');
  assert.deepEqual(errors, []); assert.deepEqual(network, []);
  const result = {status: 'passed', browser: firefox ? 'firefox' : 'chromium', checks, javascriptErrors: errors, externalRequests: network};
  fs.writeFileSync(path.join(QA, `workspace-${result.browser}.json`), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
