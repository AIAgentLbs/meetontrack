// Renders the After view for a design critique: the fixtures below at 1440, 1024 and 400 px, light and dark, Russian and
// English (with fixture data in the page's language), full page, into <out-dir>, with index.html and manifest.json.
// Opened states are opened before the shot: answered_open unfolds the first folded line of the board, transcript_open
// opens the transcript. The view scrolls inside its own section, so the viewport grows until nothing scrolls inside the
// page and the full page shows the whole view; the manifest keeps the viewport and the inner scroll from before the fit.
// refining pauses the page's clock once it has loaded, so no poll brings the refined summary before both shots; a second
// poll by the last shot fails the page.
// Reduced motion. A page that fails to load is a failure entry in the manifest and the run goes on. Exits 1 when a page
// failed, raised an error or scrolled horizontally. It does not run the critique.
// Usage: PLAYWRIGHT_MODULE=... node scripts/render-after-critique.cjs <out-dir>
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { states, open } = require('./after-fixtures.cjs');

const FIXTURES = ['just_stopped', 'draft', 'refining', 'showing', 'changes', 'held', 'sending', 'sent', 'edited', 'failed', 'no_channels',
  'no_memo', 'memo_failed', 'removed', 'answered_open', 'transcript_open'];
const OPENERS = { answered_open: '#after-board button.ql[aria-expanded]', transcript_open: '#after-transcript' };
const out = process.argv[2];
if (!out) {
  console.error('Usage: node scripts/render-after-critique.cjs <out-dir>');
  process.exit(2);
}
const missing = FIXTURES.filter(name => !(name in states));
if (missing.length) {
  console.error(`Missing fixtures: ${missing.join(', ')}`);
  process.exit(1);
}

// What scrolls inside an element (the After section, an open panel): [[selector, extra px]].
const inner = page => page.evaluate(() => [...document.body.querySelectorAll('*')]
  .filter(node => ['auto', 'scroll'].includes(getComputedStyle(node).overflowY) && node.checkVisibility())
  .map(node => [`${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}`, node.scrollHeight - node.clientHeight])
  .filter(([, extra]) => extra > 1));

// Grows the viewport by what still scrolls inside an element, so a full-page shot holds the whole view. Returns the
// viewport before the fit, for the manifest; throws when something still scrolls inside after 3 rounds.
async function fit(page, width) {
  const before = { height: page.viewportSize().height, scrolled: await inner(page) };
  let scrolled = before.scrolled;
  for (let round = 0; round < 3 && scrolled.length; round += 1) {
    await page.setViewportSize({ width, height: page.viewportSize().height + Math.max(...scrolled.map(([, extra]) => extra)) });
    scrolled = await inner(page);
  }
  if (scrolled.length) throw new Error(`still scrolls inside after 3 rounds: ${JSON.stringify(scrolled)}`);
  return before;
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const manifest = [];
  const problems = [];
  try {
    for (const state of FIXTURES) {
      for (const lang of ['ru', 'en']) {
        for (const width of [1440, 1024, 400]) {
          // A page per width, so the times stay relative to the moment of the shot.
          let page = null;
          try {
            page = await open(browser, { fixture: state, width, lang, data: lang, at: state === 'refining' ? Date.now() : null });
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.waitForFunction(lang => document.documentElement.lang === lang
              && document.body.dataset.view === 'after' && !document.getElementById('after').hidden
              && document.querySelector('#after-send .after-headline')?.textContent, lang, { timeout: 5000 });
            if (state === 'refining') await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
            if (OPENERS[state]) await page.locator(OPENERS[state]).first().click();
            const before = await fit(page, width);
            const shots = [];
            for (const scheme of ['light', 'dark']) {
              const file = `${state}-${width}-${scheme}-${lang}.png`;
              await page.emulateMedia({ colorScheme: scheme });
              if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) problems.push(`${file}: horizontal scroll`);
              await page.screenshot({ path: path.join(out, file), fullPage: true });
              shots.push({ state, width, scheme, lang, file, before });
            }
            if (state === 'refining' && page.api.afterPolls !== 1) throw new Error(`refining: ${page.api.afterPolls} polls by the last shot`);
            manifest.push(...shots);
          } catch (error) {
            problems.push(`${state} ${width} ${lang}: ${error.message}`);
            manifest.push({ state, width, lang, failed: error.message });
          }
          if (!page) continue;
          for (const error of page.errors) problems.push(`${state} ${width} ${lang}: page error ${error}`);
          await page.context().close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const figures = manifest.filter(entry => entry.file).map(({ state, width, scheme, lang, file }) =>
    `<figure><img src="${file}" alt="${state} ${width} ${scheme} ${lang}" loading="lazy"><figcaption>${state}, ${width} px, ${scheme}, ${lang}</figcaption></figure>`);
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>After critique renders</title></head>\n<body>\n<h1>After view: ${figures.length} renders</h1>\n${figures.join('\n')}\n</body></html>\n`);
  console.log(`${figures.length} renders in ${out}`);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
