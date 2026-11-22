// Renders the Call view for a design critique: the fixtures below at 1440, 1024 and 400 px, light and dark, Russian and
// English (with fixture data in the page's language), full page, into <out-dir>, with index.html and manifest.json.
// Opened states are opened before the shot: through the dock buttons above 700 px, through More at 400 px. More shows
// only under 700 px, so more_open renders at 400 px alone. Exits 1 when a page raised an error or scrolled horizontally.
// It does not run the critique.
// Usage: PLAYWRIGHT_MODULE=... node scripts/render-call-critique.cjs <out-dir>
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { states, open } = require('./call-fixtures.cjs');

const FIXTURES = ['hint', 'answer', 'heard', 'memo_question', 'waiting', 'paused_ai', 'other_lost', 'you_lost', 'own_answer',
  'earlier_open', 'stopped', 'more_open', 'transcript_open', 'board_open', 'long_hint'];
// state -> [dock button, More item]
const OPENERS = { earlier_open: ['earlier', 'earlier'], transcript_open: ['transcript', 'transcript'], board_open: ['board', 'board'] };
const out = process.argv[2];
if (!out) {
  console.error('Usage: node scripts/render-call-critique.cjs <out-dir>');
  process.exit(2);
}
const missing = FIXTURES.filter(name => !(name in states));
if (missing.length) {
  console.error(`Missing fixtures: ${missing.join(', ')}`);
  process.exit(1);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const manifest = [];
  const problems = [];
  try {
    for (const state of FIXTURES) {
      for (const lang of ['ru', 'en']) {
        for (const width of state === 'more_open' ? [400] : [1440, 1024, 400]) {
          // A page per width: the dock and More differ by width, and the stop fixture's clock stays fresh.
          const page = await open(browser, { fixture: state, width, lang, data: lang });
          try {
            await page.waitForFunction(lang => document.documentElement.lang === lang, lang);
            await page.waitForSelector('#call:not([hidden]) #call-slot > *', { timeout: 5000 });
            if (state === 'more_open') await page.click('#call-more');
            if (OPENERS[state]) {
              const [dock, item] = OPENERS[state];
              if (width > 700) await page.click(`#call-${dock}-open`);
              else {
                await page.click('#call-more');
                await page.click(`#call-more-${item}`);
              }
            }
            for (const scheme of ['light', 'dark']) {
              const file = `${state}-${width}-${scheme}-${lang}.png`;
              await page.emulateMedia({ colorScheme: scheme });
              if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) problems.push(`${file}: horizontal scroll`);
              await page.screenshot({ path: path.join(out, file), fullPage: true });
              manifest.push({ state, width, scheme, lang, file });
            }
          } catch (error) {
            problems.push(`${state} ${width} ${lang}: ${error.message}`);
          }
          for (const error of page.errors) problems.push(`${state} ${width} ${lang}: page error ${error}`);
          await page.context().close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const figures = manifest.map(({ state, width, scheme, lang, file }) =>
    `<figure><img src="${file}" alt="${state} ${width} ${scheme} ${lang}" loading="lazy"><figcaption>${state}, ${width} px, ${scheme}, ${lang}</figcaption></figure>`);
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Call critique renders</title></head>\n<body>\n<h1>Call view: ${manifest.length} renders</h1>\n${figures.join('\n')}\n</body></html>\n`);
  console.log(`${manifest.length} renders in ${out}`);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
