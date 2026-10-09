/* Focused side-project acceptance for the real offline export and Python server.
 * OPEN_FIELD_PYTHON can select the interpreter used for the HTTP check.
 */
const playwright = require(process.env.OPEN_FIELD_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'submission'));
const QA = path.join(OUT, 'qa');
const ASSETS = path.join(ROOT, 'web/side-projects/fruit-fly-in-the-pocket');
const project = JSON.parse(fs.readFileSync(path.join(ASSETS, 'project.json'), 'utf8'));
const original = fs.readFileSync(path.join(ASSETS, project.presentation));
const preview = fs.readFileSync(path.join(ASSETS, project.preview));
const extra = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/packs/week-1-additional/demo.json'), 'utf8'));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const checks = [];
const firefox = process.argv.includes('--firefox');

async function startServer() {
  const python = process.env.OPEN_FIELD_PYTHON || process.env.PYTHON || 'python';
  const child = spawn(python, ['-u', path.join(ROOT, 'app.py'), '--port', '0', '--no-browser'], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-6000); });
  async function stop() {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  }
  try {
    const url = await new Promise((resolve, reject) => {
      // This is a startup deadline, not a delay before inspecting the application.
      const deadline = setTimeout(() => reject(new Error(`Python server did not announce readiness: ${errors}`)), 30000);
      const cleanup = () => { clearTimeout(deadline); child.off('exit', onExit); child.off('error', onError); child.stdout.off('data', onData); };
      const onExit = code => { cleanup(); reject(new Error(`Python server exited ${code}: ${errors}`)); };
      const onError = error => { cleanup(); reject(error); };
      const onData = chunk => {
        output += chunk.toString();
        const ready = output.match(/Open Field is ready: (http:\/\/127\.0\.0\.1:\d+)/);
        if (ready) { cleanup(); resolve(ready[1]); }
      };
      child.once('exit', onExit); child.once('error', onError); child.stdout.on('data', onData);
    });
    return {url, stop};
  } catch (error) { await stop(); throw error; }
}

async function exercise(browser, mode, url) {
  const context = await browser.newContext({viewport: {width: 1440, height: 1080}, acceptDownloads: true});
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  const note = message => checks.push(`${mode}: ${message}`);
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.OpenFieldApp && document.querySelector('#sideProjectOpen') && !document.querySelector('#sideProjectBanner').hidden);
    const banner = page.locator('#sideProjectBanner');
    assert(await banner.isVisible());
    assert.equal(await banner.getAttribute('aria-label'), 'Side project');
    assert.match((await banner.locator('.side-project-label').innerText()).trim(), /^side project$/i);
    assert.equal(await page.locator('#sideProjectName').innerText(), 'Fruit fly in the pocket');
    const ordering = await page.evaluate(() => {
      const banner = document.querySelector('#sideProjectBanner'), header = document.querySelector('.topbar');
      return {before: Boolean(banner.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING), bottom: banner.getBoundingClientRect().bottom, headerTop: header.getBoundingClientRect().top};
    });
    assert(ordering.before && ordering.bottom <= ordering.headerTop + 1, 'Clearly labelled banner must precede the main application header');
    note('labelled banner is visible before the coaching header');

    await page.evaluate(() => OpenFieldApp.pause());
    const snapshot = await page.evaluate(() => OpenFieldApp.getSnapshot());
    const dialog = page.locator('#sideProjectDialog');
    async function open() {
      await page.locator('#sideProjectOpen').click();
      await page.waitForFunction(() => document.querySelector('#sideProjectDialog').open);
      assert(await dialog.isVisible());
    }
    async function assertClosedUnchanged(expected) {
      await page.waitForFunction(() => !document.querySelector('#sideProjectDialog').open && document.activeElement.id === 'sideProjectOpen');
      assert.deepEqual(await page.evaluate(() => OpenFieldApp.getSnapshot()), expected);
      assert.equal(await page.evaluate(() => OpenFieldApp.state.playing), false);
    }
    await open();
    assert.equal(await page.locator('#sideProjectTitle').innerText(), project.title);
    assert.match(await page.locator('#sideProjectSlideCount').innerText(), /^14 slides/);
    assert.equal(await dialog.getAttribute('aria-labelledby'), 'sideProjectTitle');
    await page.waitForFunction(() => { const img = document.querySelector('#sideProjectPreview'); return img.complete && img.naturalWidth > 0; });
    const image = await page.locator('#sideProjectPreview').evaluate(img => ({width: img.naturalWidth, height: img.naturalHeight, source: img.currentSrc, alt: img.alt}));
    assert.equal(image.width, preview.readUInt32BE(16)); assert.equal(image.height, preview.readUInt32BE(20));
    assert(image.source.startsWith('data:image/png;base64,')); assert(image.alt.length > 20);
    note('dialog shows the real title, fourteen slides and a decoded embedded preview');

    await dialog.evaluate(element => element.focus());
    assert.equal(await page.evaluate(() => document.activeElement.id), 'sideProjectDialog');
    for (const key of ['ArrowRight', 'ArrowLeft', ']', '[', 'f', 'Space']) await page.keyboard.press(key);
    assert(await dialog.evaluate(element => element.open));
    assert.deepEqual(await page.evaluate(() => OpenFieldApp.getSnapshot()), snapshot);
    assert.equal(await page.evaluate(() => OpenFieldApp.state.playing), false);
    await page.keyboard.press('Escape'); await assertClosedUnchanged(snapshot);
    await open(); await page.locator('#sideProjectClose').click(); await assertClosedUnchanged(snapshot);
    note('Escape and Close restore focus; coaching shortcuts and snapshot remain unchanged');

    async function download(suffix) {
      const pending = page.waitForEvent('download');
      await page.locator('#sideProjectDownload').click();
      const result = await pending;
      assert.equal(result.suggestedFilename(), project.presentation);
      const destination = path.join(QA, `side-project-${mode}${suffix}.pptx`);
      await result.saveAs(destination);
      const downloaded = fs.readFileSync(destination);
      assert(downloaded.equals(original), 'The download must exactly preserve the original presentation bytes');
      assert.equal(digest(downloaded), digest(original));
    }
    await open(); await download('');
    await page.locator('#sideProjectClose').click(); await assertClosedUnchanged(snapshot);
    note('actual PowerPoint download matches every original byte and SHA-256');

    await page.setViewportSize({width: 390, height: 844});
    await page.waitForFunction(() => window.innerWidth === 390);
    assert(await banner.isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), 'Mobile page must not overflow horizontally');
    await open();
    assert(await page.evaluate(() => {
      const dialog = document.querySelector('#sideProjectDialog'), bounds = dialog.getBoundingClientRect(), body = dialog.querySelector('.side-project-body');
      return bounds.left >= -1 && bounds.right <= innerWidth + 1 && dialog.scrollWidth <= dialog.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1;
    }), 'The mobile dialog and its content must stay within the viewport');
    await page.screenshot({path: path.join(QA, `side-project-${mode}-mobile.png`), fullPage: true});
    await page.locator('#sideProjectClose').click(); await assertClosedUnchanged(snapshot);
    note('390-pixel banner and dialog remain usable without horizontal overflow');

    await page.evaluate(payload => OpenFieldApp.loadDataset(payload), extra);
    assert.equal(await page.evaluate(() => OpenFieldApp.data.plays.length), extra.plays.length);
    assert.equal(await page.locator('#sideProjectBanner').count(), 1);
    const loaded = await page.evaluate(() => OpenFieldApp.getSnapshot());
    await open(); await download('-after-pack');
    await page.locator('#sideProjectClose').click(); await assertClosedUnchanged(loaded);
    note('banner, dialog and original download survive loading another game pack');

    assert.deepEqual(errors, []);
    if (mode === 'offline') assert.deepEqual(requests, [], 'Offline viewing and downloading must not make runtime HTTP requests');
    else assert(requests.every(value => { const request = new URL(value); return request.origin === new URL(url).origin && ['/', '/favicon.ico'].includes(request.pathname); }), `Only initial local application requests are allowed: ${JSON.stringify(requests)}`);
    note('no script errors or unexpected runtime network requests');
  } finally { await context.close(); }
}

(async () => {
  fs.mkdirSync(QA, {recursive: true});
  assert.equal(project.slideCount, 14);
  const browser = await (firefox ? playwright.firefox : playwright.chromium).launch({headless: true, ...(!firefox && process.env.OPEN_FIELD_BROWSER ? {executablePath: process.env.OPEN_FIELD_BROWSER} : {})});
  let server;
  try {
    await exercise(browser, 'offline', pathToFileURL(path.join(OUT, 'Open-Field.html')).href);
    server = await startServer();
    await exercise(browser, 'http', server.url);
    assert(fs.readFileSync(path.join(ASSETS, project.presentation)).equals(original), 'The source presentation must remain unmodified');
  } finally { if (server) await server.stop(); await browser.close(); }
  const result = {status: 'passed', browser: firefox ? 'firefox' : 'chromium', originalSha256: digest(original), originalBytes: original.length, checks};
  fs.writeFileSync(path.join(QA, `side-project-${result.browser}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
