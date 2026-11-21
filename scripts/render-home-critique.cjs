// Renders Home and the app chrome for a design critique: every fixture at 1440, 1024 and 400 px, light and dark,
// Russian and English, full page, into <out-dir>, with index.html and manifest.json. Exits 1 when a page raised an
// error or scrolled horizontally. It does not run the critique.
// Usage: PLAYWRIGHT_MODULE=... node scripts/render-home-critique.cjs <out-dir>
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { states, open } = require('./home-fixtures.cjs');

const MENU = ['menu_open', 'menu_narrow'];
const out = process.argv[2];
if (!out) {
  console.error('Usage: node scripts/render-home-critique.cjs <out-dir>');
  process.exit(2);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const manifest = [];
  const problems = [];
  try {
    for (const state of Object.keys(states)) {
      for (const lang of ['ru', 'en']) {
        const page = await open(browser, { fixture: state, lang });
        try {
          await page.waitForFunction(lang => document.documentElement.lang === lang, lang);
          await page.locator('#home :is(.row, .empty)').first().waitFor({ timeout: 5000 });
          if (MENU.includes(state)) await page.locator('#menu-button').click();
          for (const width of [1440, 1024, 400]) {
            for (const scheme of ['light', 'dark']) {
              const file = `${state}-${width}-${scheme}-${lang}.png`;
              await page.setViewportSize({ width, height: 900 });
              await page.emulateMedia({ colorScheme: scheme });
              if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) problems.push(`${file}: horizontal scroll`);
              await page.screenshot({ path: path.join(out, file), fullPage: true });
              manifest.push({ state, width, scheme, lang, file });
            }
          }
        } catch (error) {
          problems.push(`${state} ${lang}: ${error.message}`);
        }
        for (const error of page.errors) problems.push(`${state} ${lang}: page error ${error}`);
        await page.context().close();
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const figures = manifest.map(({ state, width, scheme, lang, file }) =>
    `<figure><img src="${file}" alt="${state} ${width} ${scheme} ${lang}" loading="lazy"><figcaption>${state}, ${width} px, ${scheme}, ${lang}</figcaption></figure>`);
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Home critique renders</title></head>\n<body>\n<h1>Home and chrome: ${manifest.length} renders</h1>\n${figures.join('\n')}\n</body></html>\n`);
  console.log(`${manifest.length} renders in ${out}`);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
