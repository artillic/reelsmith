/**
 * Browser regression tests for the dashboard.
 *
 * The unit suite covers pure logic and cannot see the class of bug that has
 * actually shipped: silent failures, a screen re-rendering itself on a timer,
 * state lost on reload, and a panel destroying the form the next step reads
 * from. Each check below corresponds to a real bug that reached the user.
 *
 * Opt-in, because it needs a browser:
 *   npm i -D playwright && npx playwright install chromium
 *   npm run test:ui
 */
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.log('playwright is not installed — skipping browser tests.');
  console.log('  npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

const PORT = 4399;
const ROOT = resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : 'NOT OK'} ${name}${detail ? ' — ' + detail : ''}`);
};

function seed(dir) {
  const clips = join(dir, 'clips', 'luxury');
  mkdirSync(clips, { recursive: true });
  for (const n of ['a.mp4', 'b.mp4']) writeFileSync(join(clips, n), Buffer.alloc(50000));

  writeFileSync(join(dir, '.env'),
    `BROLL_DIR="${join(dir, 'clips')}"\nREEL_TIMEZONE=Asia/Bangkok\n` +
    'METRICOOL_TOKEN=t\nMETRICOOL_USER_ID=1\nMETRICOOL_BLOG_ID=2\n' +
    'SUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=k\n');

  const ids = ['seed', 'young'];
  const at = new Date().toISOString();
  const out = join(dir, 'content', 'demo-reel', 'out');
  mkdirSync(out, { recursive: true });
  const clip = join(clips, 'a.mp4');

  writeFileSync(join(dir, 'content', 'demo-reel', 'spec.json'), JSON.stringify({
    slug: 'demo-reel', topic: 'thailand', createdAt: '2026-08-16T00:00:00.000Z',
    caption: '1. one\n2. two', seedHook: '22 reasons you should move to Thailand',
    brollPool: [clip], style: 'outline', size: 'medium', position: 'top',
    hooks: ids.map((id) => ({ id, text: `22 reasons ${id} should move`, variation: id, brollPath: null })),
  }, null, 2));

  const variants = {};
  for (const id of ids) {
    writeFileSync(join(out, `${id}.mp4`), Buffer.alloc(200000));
    variants[id] = { render: { at, hookText: `22 reasons ${id} should move`, clip,
      style: 'outline', size: 'medium', position: 'top', bytes: 200000 } };
  }
  writeFileSync(join(dir, 'content', 'demo-reel', 'state.json'), JSON.stringify({ variants }, null, 2));
}

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reelsmith-e2e-'));
  seed(dir);

  const server = spawn('node', ['--experimental-strip-types', join(ROOT, 'src', 'cli.ts'),
    'dashboard', '--port', String(PORT)], { cwd: dir, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    const base = `http://localhost:${PORT}/`;
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Reload must not lose the open reel.
    check('a reel opens without visiting the New reel screen',
      (await page.$eval('#project-switch', (e) => e.value)) === 'demo-reel');
    await page.click('[data-go="review"]');
    await page.waitForTimeout(900);
    check('Review shows the variants straight away',
      (await page.$$eval('#variants .variant', (v) => v.length)) === 2);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1100);
    check('a hard refresh keeps the reel open',
      (await page.$eval('#project-switch', (e) => e.value)) === 'demo-reel');

    // Generate must never fail silently.
    await page.click('[data-go="create"]');
    await page.waitForTimeout(300);
    await page.click('#btn-ideate');
    await page.waitForTimeout(300);
    const said = (await page.$eval('#ideate-log', (e) => e.innerText)).trim();
    check('Generate with empty fields says what is missing', said.length > 0, said.split('\n')[0]);

    // The screen must not rebuild itself on a timer.
    await page.click('[data-go="publish"]');
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      window.__rebuilds = 0;
      new MutationObserver(() => { window.__rebuilds++; })
        .observe(document.getElementById('publish-body'), { childList: true });
    });
    let scheduleCalls = 0;
    page.on('request', (r) => { if (r.url().includes('/api/schedule')) scheduleCalls++; });
    await page.waitForTimeout(6000);
    const rebuilds = await page.evaluate(() => window.__rebuilds);
    check('Publish does not rebuild itself while idle', rebuilds === 0, `${rebuilds} rebuilds`);
    check('no background replanning while idle', scheduleCalls === 0, `${scheduleCalls} calls`);

    // The confirmation panel replaces the form; the commit must still know the times.
    const beforeStart = await page.$eval('#p-start', (e) => e.value);
    await page.click('#btn-review');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => paceOptions());
    check('the form is replaced by the confirmation', !(await page.$('#p-start')));
    check('scheduling options survive the form being replaced',
      after.start === beforeStart && !!after.timezone, `start=${after.start}`);

    check('no uncaught page errors anywhere', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
