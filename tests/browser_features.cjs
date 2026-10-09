/* Coaching workflow acceptance checks in a real offline browser. */
const { chromium } = require(process.env.OPEN_FIELD_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, '../submission'));
const checks = [];

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.OPEN_FIELD_BROWSER ? { executablePath: process.env.OPEN_FIELD_BROWSER } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const page = await context.newPage(), errors = [], network = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await page.goto(pathToFileURL(path.join(OUT, 'Open-Field.html')).href);
  await page.waitForFunction(() => window.OpenFieldApp && window.OpenFieldWorkspace);
  const initial = await page.evaluate(() => OpenFieldApp.getSnapshot());
  assert.equal(await page.locator('.board').count(), 1);
  assert.match(await page.locator('#storyCaption').innerText(), /./);
  checks.push('curated real-play entry and complete offline initialization');

  await page.evaluate(() => OpenFieldApp.seek(1.2));
  const otherReceiver = await page.evaluate(() => OpenFieldApp.getPlay('a').players.find(p => p.role === 'route' && String(p.id) !== OpenFieldApp.state.receivers.a).id);
  await page.locator('#receiver-a').selectOption(String(otherReceiver));
  assert.equal(await page.evaluate(() => OpenFieldApp.state.t), 1.2);
  await page.locator('#stepForward').click();
  assert(Math.abs(await page.evaluate(() => OpenFieldApp.state.t) - 1.3) < .001);
  await page.locator('#stepBack').click();
  assert(Math.abs(await page.evaluate(() => OpenFieldApp.state.t) - 1.2) < .001);
  checks.push('receiver selection preserves time; stepping uses observed frames');

  await page.locator('#compareButton').click();
  assert.equal(await page.locator('.board').count(), 2);
  assert.equal(await page.evaluate(() => OpenFieldApp.state.t), 1.2);
  await page.locator('#alignment').selectOption('manual');
  await page.locator('#manualAnchorA').fill('1'); await page.locator('#manualAnchorA').dispatchEvent('change');
  await page.locator('#manualAnchorB').fill('2'); await page.locator('#manualAnchorB').dispatchEvent('change');
  const timing = await page.evaluate(() => ({ a: OpenFieldApp.getTimeOffset('a'), b: OpenFieldApp.getTimeOffset('b'), saved: OpenFieldApp.getSnapshot().manualAnchors }));
  assert.deepEqual(timing, { a: -1, b: 0, saved: { a: 1, b: 2 } });
  await page.locator('#alignment').selectOption('firstDownfield');
  assert.match(await page.locator('#clockDescription').innerText(), /first downfield arrival/);
  const scales = await page.evaluate(() => Object.values(OpenFieldApp.getBoards()).map(b => b.transform.scale));
  assert(Math.abs(scales[0] - scales[1]) < .001);
  checks.push('manual and first-downfield alignment preserve shared field scale');

  await page.locator('[data-tab="compare"]').click();
  await page.locator('#compareSamePlay').click();
  const paired = await page.evaluate(() => ({ a: OpenFieldApp.state.a, b: OpenFieldApp.state.b, receivers: OpenFieldApp.state.receivers }));
  assert.equal(paired.a, paired.b); assert.notEqual(paired.receivers.a, paired.receivers.b);
  await page.locator('#removeCompare').click();
  await page.locator('#alignment').selectOption('snap', { force: true });
  checks.push('same-play receiver comparison is supported');

  await page.locator('#search').fill('no-matching-player-qzj');
  assert.equal(await page.locator('.play-option').count(), 0);
  assert(await page.locator('#hiddenSelection').isVisible());
  await page.locator('#resetFilters').click();
  const playerName = await page.evaluate(() => OpenFieldApp.getPlay('a').players.find(p => p.role === 'route').name);
  await page.locator('#search').fill(playerName); assert(await page.locator('.play-option').count() > 0);
  await page.locator('#resetFilters').click();
  checks.push('player-name search, empty state, filtered-selection warning and reset');

  await page.locator('#settingsButton').click();
  await page.locator('#heatMask').selectOption('downfield');
  await page.locator('[data-layer="lane"]').check();
  await page.locator('#fieldZoom').selectOption('1.6');
  await page.locator('#largeText').check();
  await page.locator('#highContrast').check();
  await page.locator('#reducedMotion').check();
  await page.locator('[data-close="settingsDialog"]').click();
  assert(await page.locator('.lane-context').isVisible());
  assert.match(await page.locator('.lane-context').innerText(), /All defenders; present positions only/);
  assert(await page.evaluate(() => document.body.classList.contains('large-text') && OpenFieldApp.state.layers.mask === 'downfield' && OpenFieldApp.state.ui.zoom === 1.6));
  checks.push('readability settings, focused heatmap and explicit exploratory passing lane');

  await page.locator('#inspectX').fill('65'); await page.locator('#inspectY').fill('26');
  await page.locator('#inspectCoordinates').click();
  await page.locator('.field-canvas').focus(); await page.keyboard.press('Control+ArrowRight');
  assert.equal(await page.evaluate(() => OpenFieldApp.state.point.x), 66);
  assert.match(await page.locator('#pointInspector').innerText(), /Pinned/);
  await page.keyboard.press('f'); assert(await page.evaluate(() => OpenFieldApp.state.ui.expanded));
  await page.keyboard.press('Escape'); assert(!(await page.evaluate(() => OpenFieldApp.state.ui.expanded)));
  checks.push('keyboard coordinate inspection and reversible expanded field');

  await page.evaluate(() => { const a = OpenFieldApp; a.setSnapshot({ ...a.getSnapshot(), ui: { ...a.getSnapshot().ui, zoom: 1, largeText: false } }); });
  await page.locator('[data-tab="routes"]').click();
  assert.match(await page.locator('#allRoutesTable').innerText(), /Raw observations/);
  assert.match(await page.locator('#allRoutesTable').innerText(), /qualified/);
  await page.locator('#minDuration').selectOption('.5');
  assert.equal(await page.evaluate(() => OpenFieldApp.state.metricOptions.minDuration), .5);
  await page.locator('#allRoutesTable [data-pair-route]').first().click();
  assert.equal(await page.evaluate(() => OpenFieldApp.state.ui.chart), 'pair');
  checks.push('shared receiver table, qualified versus raw windows and paired-route navigation');

  const prePlay = await page.evaluate(() => OpenFieldApp.data.plays.find(p => p.preSnap?.times?.length)?.id);
  assert(prePlay, 'fixture should provide real pre-snap context');
  await page.evaluate(id => OpenFieldApp.selectPlay('a', id), prePlay);
  await page.locator('#settingsButton').click(); await page.locator('#preSnapButton').click();
  await page.locator('[data-close="settingsDialog"]').click();
  const preview = await page.evaluate(() => ({ snapshot: OpenFieldApp.getSnapshot(), time: OpenFieldApp.getObservedTime('a') }));
  assert(preview.time < 0); assert(preview.snapshot.preSnap);
  await page.evaluate(() => OpenFieldApp.seek(.5));
  await page.evaluate(saved => OpenFieldApp.setSnapshot(saved), preview.snapshot);
  assert.equal(await page.evaluate(() => OpenFieldApp.getObservedTime('a')), preview.time);
  assert.match(await page.locator('.metric-equation').innerText(), /paused/);
  checks.push('real negative pre-snap view and exact saved-frame restoration');

  await page.evaluate(saved => OpenFieldApp.setSnapshot(saved), initial);
  assert(!(await page.locator('#pointInspector').innerText()).includes('Pinned'), 'restoring an unpinned view clears the previous point result');
  const rejected = await page.evaluate(() => { const before = OpenFieldApp.getSnapshot(); let rejected = false; try { OpenFieldApp.setSnapshot({ ...before, a: OpenFieldApp.data.plays[1].id, metricOptions: { ...before.metricOptions, scope: 'invented' } }); } catch { rejected = true; } return { rejected, unchanged: JSON.stringify(before) === JSON.stringify(OpenFieldApp.getSnapshot()) }; });
  assert.deepEqual(rejected, { rejected: true, unchanged: true });
  checks.push('invalid saved state rejection is atomic');

  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(150);
  assert(await page.locator('#playButton').isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), 'mobile page should not overflow horizontally');
  await page.locator('#stepForward').click();
  const qa = path.join(OUT, 'qa'); fs.mkdirSync(qa, { recursive: true });
  await page.screenshot({ path: path.join(qa, 'features-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1080 }); await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(qa, 'features-desktop.png'), fullPage: true });
  checks.push('mobile and desktop layouts retain accessible replay controls');
  assert.deepEqual(errors, []); assert.deepEqual(network, []);
  fs.writeFileSync(path.join(qa, 'features-checks.json'), JSON.stringify({ checks, errors, network }, null, 2));
  await browser.close(); console.log(`${checks.length} coaching UI checks passed.`);
})().catch(error => { console.error(error); process.exit(1); });
