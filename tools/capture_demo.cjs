/* Reproduce the release screenshots from the actual offline tool. */
const playwright = require(process.env.OPEN_FIELD_PLAYWRIGHT || 'playwright');
const fs = require('node:fs'), path = require('node:path');
const {pathToFileURL} = require('node:url');
const out = path.resolve(process.argv[2] || path.join(__dirname, '../submission'));
(async () => {
  const browser = await playwright.chromium.launch({headless: true, ...(process.env.OPEN_FIELD_BROWSER ? {executablePath: process.env.OPEN_FIELD_BROWSER} : {})});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1080}});
    await page.goto(pathToFileURL(path.join(out, 'Open-Field.html')).href);
    await page.waitForFunction(() => window.OpenFieldWorkspace);
    await page.evaluate(() => { OpenFieldApp.pause(); OpenFieldApp.state.ui.chart = 'lift'; OpenFieldApp.render(); document.activeElement?.blur(); });
    await page.screenshot({path: path.join(out, 'Open-Field-preview.png'), fullPage: true});
    await page.evaluate(() => {
      const state = OpenFieldApp.getSnapshot();
      Object.assign(state, {a: '2021110100_2120', b: '2021110100_1396', t: 2.3, alignment: 'manual', manualAnchors: {a: 2.1, b: 2.3}, receivers: {a: '44835', b: '43454'}, focusPlayers: {a: '44835', b: '43454'}});
      OpenFieldApp.setSnapshot(state);
      document.querySelector('#ofExportTitle').value = 'Two openings, different movement contributions';
      OpenFieldWorkspace.workspace.notes[state.a] = [{time: 2.1, text: 'Defensive movement adds spacing while receiver movement reduces it.'}];
      OpenFieldWorkspace.workspace.notes[state.b] = [{time: 2.3, text: 'Receiver movement supplies most of the separation gain.'}];
    });
    await page.screenshot({path: path.join(out, 'Open-Field-comparison-ui.png'), fullPage: true});
    const png = await page.evaluate(() => OpenFieldWorkspace.renderEvidenceCanvas().toDataURL('image/png').split(',')[1]);
    fs.writeFileSync(path.join(out, 'Open-Field-comparison.png'), Buffer.from(png, 'base64'));
    console.log('Captured default Coverage Lift view, aligned comparison, and native evidence image.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
