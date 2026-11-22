// render-call-critique.cjs (fix wave F1-F3): stopped_final is rendered, the audio bars are still during shots, and a
// page that fails to load is a failure entry in the manifest while the run goes on, then exits 1.
// Every page load except hint and stopped_final at 400 px in English is made to fail, so the run takes seconds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'render-critique-'));
const preload = path.join(out, 'preload.cjs');
fs.writeFileSync(preload, `
const fixtures = require(${JSON.stringify(path.join(__dirname, 'call-fixtures.cjs'))});
const fs = require('node:fs');
const open = fixtures.open;
fixtures.open = async (browser, options) => {
  if (!(['hint', 'stopped_final'].includes(options.fixture) && options.width === 400 && options.lang === 'en')) throw new Error('injected load failure');
  const page = await open(browser, options);
  const shot = page.screenshot.bind(page);
  page.screenshot = async (...args) => {
    // The bars of a side that speaks: their animation must not run while the shot is taken.
    const moving = await page.evaluate(() => [...document.querySelectorAll('.bars:not(.quiet) i')].filter(bar => bar.checkVisibility())
      .map(bar => bar.getAnimations().some(animation => animation.playState === 'running')));
    fs.appendFileSync(${JSON.stringify(path.join(out, 'bars.txt'))}, JSON.stringify([options.fixture, moving.length, moving.some(Boolean)]) + '\\n');
    return shot(...args);
  };
  return page;
};
`);
const run = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, 'render-call-critique.cjs'), out],
  { env: process.env, encoding: 'utf8', timeout: 120000 });
assert.equal(run.status, 1, `exit 1 after a failed load\n${run.stdout}\n${run.stderr}`);
const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
const shots = manifest.filter(entry => entry.file);
assert.deepEqual(shots.map(entry => entry.file), ['hint-400-light-en.png', 'hint-400-dark-en.png',
  'stopped_final-400-light-en.png', 'stopped_final-400-dark-en.png']);
for (const { file } of shots) assert.ok(fs.statSync(path.join(out, file)).size > 0, file);
const failed = manifest.filter(entry => entry.failed);
// 15 states at 3 widths and more_open at 1, in 2 languages, less the two pages that loaded.
assert.equal(failed.length, (15 * 3 + 1) * 2 - 2, 'every other page is a failure entry');
assert.ok(failed.every(entry => entry.failed.includes('injected load failure')));
const bars = fs.readFileSync(path.join(out, 'bars.txt'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
assert.ok(bars.filter(([fixture]) => fixture === 'hint').every(([, count]) => count > 0), `the hint shot has speaking bars: ${JSON.stringify(bars)}`);
assert.ok(bars.every(([, , moving]) => !moving), `bars still during shots: ${JSON.stringify(bars)}`);
fs.rmSync(out, { recursive: true, force: true });
console.log('render critique: stopped_final rendered, bars still, a failed load recorded and the run continues: OK');
