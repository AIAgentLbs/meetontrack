// render-after-critique.cjs: answered_open is shot unfolded, refining before the refined summary, nothing scrolls inside the
// page during a shot, the manifest keeps the viewport from before the fit, and a page that fails to load is a failure entry
// in the manifest while the run goes on, then exits 1. A second run lets a second poll land before refining's last shot,
// and that page must fail. Every page load except answered_open and refining at 1440 px in English is made to fail.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'render-after-critique-'));
const preload = path.join(out, 'preload.cjs');
fs.writeFileSync(preload, `
const fixtures = require(${JSON.stringify(path.join(__dirname, 'after-fixtures.cjs'))});
const fs = require('node:fs');
const open = fixtures.open;
fixtures.open = async (browser, options) => {
  if (!(['answered_open', 'refining'].includes(options.fixture) && options.width === 1440 && options.lang === 'en')) throw new Error('injected load failure');
  const page = await open(browser, options);
  const shot = page.screenshot.bind(page);
  page.screenshot = async (...args) => {
    const seen = await page.evaluate(() => ({
      expanded: document.querySelector('#after-board button.ql[aria-expanded]')?.getAttribute('aria-expanded'),
      inner: Math.max(0, ...[...document.body.querySelectorAll('*')].filter(node => ['auto', 'scroll'].includes(getComputedStyle(node).overflowY))
        .map(node => node.scrollHeight - node.clientHeight)),
    }));
    // The page's clock stands still during refining's shots: no poll can come by itself.
    const clock = await page.evaluate(() => Date.now());
    await new Promise(resolve => setTimeout(resolve, 200));
    seen.held = clock === await page.evaluate(() => Date.now());
    if (process.env.INJECT_POLL && options.fixture === 'refining' && args[0].path.includes('-dark-')) {
      // A poll lands between the two shots: the clock is moved past the next one, and the page waits for it.
      await page.clock.runFor(3100);
      for (let wait = 0; page.api.afterPolls < 2 && wait < 50; wait += 1) await new Promise(resolve => setTimeout(resolve, 100));
    }
    fs.appendFileSync(${JSON.stringify(path.join(out, 'seen.txt'))}, JSON.stringify({ fixture: options.fixture, polls: page.api.afterPolls, ...seen }) + '\\n');
    return shot(...args);
  };
  return page;
};
`);
function render(dir, env = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const run = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, 'render-after-critique.cjs'), dir],
    { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 });
  assert.equal(run.status, 1, `exit 1 after a failed load\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

const manifest = render(path.join(out, 'run'));
const shots = manifest.filter(entry => entry.file);
assert.deepEqual(shots.map(entry => entry.file), ['refining-1440-light-en.png', 'refining-1440-dark-en.png',
  'answered_open-1440-light-en.png', 'answered_open-1440-dark-en.png']);
for (const { file } of shots) assert.ok(fs.statSync(path.join(out, 'run', file)).size > 0, file);
const failed = manifest.filter(entry => entry.failed);
// 16 states at 3 widths in 2 languages, less the two pages that loaded.
assert.equal(failed.length, 16 * 3 * 2 - 2, 'every other page is a failure entry');
assert.ok(failed.every(entry => entry.failed.includes('injected load failure')));
const seen = fs.readFileSync(path.join(out, 'seen.txt'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
assert.ok(seen.filter(entry => entry.fixture === 'answered_open').every(entry => entry.expanded === 'true'), `unfolded: ${JSON.stringify(seen)}`);
assert.ok(seen.filter(entry => entry.fixture === 'refining').every(entry => entry.polls === 1 && entry.held),
  `before the refined summary, on a held clock: ${JSON.stringify(seen)}`);
assert.ok(seen.every(entry => entry.inner <= 1), `nothing scrolls inside the page: ${JSON.stringify(seen)}`);
assert.ok(shots.every(entry => entry.before.height === 900 && entry.before.scrolled.some(([selector]) => selector === 'section#after')),
  `the viewport before the fit: ${JSON.stringify(shots.map(entry => entry.before))}`);

// A second poll before refining's last shot: the page is a failure entry, not two shots.
fs.rmSync(path.join(out, 'seen.txt'));
const late = render(path.join(out, 'late'), { INJECT_POLL: '1' })
  .filter(entry => entry.state === 'refining' && entry.width === 1440 && entry.lang === 'en');
assert.equal(late.length, 1, JSON.stringify(late));
assert.match(late[0].failed || '', /refining: 2 polls by the last shot/);
fs.rmSync(out, { recursive: true, force: true });
console.log('render after critique: opened and refining states shot as meant, the whole view in the shot, a late poll fails refining, a failed load recorded and the run continues: OK');
