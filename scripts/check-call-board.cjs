// Isolated UI smoke: synthetic meeting data; no real analysis or meeting writes.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/m/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const journal = [
    { id: 'a', category: 'ASK', text: 'Кто принимает окончательное решение?\nОснование: ответственный пока не назван.\nИсточник: текущая встреча.' },
    { id: 'b', category: 'INCOMING_QUESTION', text: 'Когда вы сможете показать рабочий пример?', status: 'clarify' },
    { id: 'c', category: 'OPEN_QUESTION', text: 'Какой следующий шаг согласуем?', status: 'resolved', evidence: 'В пятницу сверим результаты и согласуем следующий шаг.' },
    { id: 'd', category: 'RISK', text: 'Не определён ответственный за проверку результата.\nИсточник: текущая встреча.' },
    { id: 'e', category: 'OBJECTION', text: 'Команда опасается, что проверка займёт слишком много времени.', status: 'clarify' },
    { id: 'f', category: 'QUESTION', text: 'USER_QUERY_MUST_NOT_APPEAR' },
  ].map(item => ({ meeting_id: 'fixture', created_at: '2026-09-30T10:00:00Z', ...item }));
  const plan = { meeting_id: 'fixture', title: 'Подготовка встречи', source_label: 'demo/docs/preparation.md',
    intro: '', links: [{ label: 'Материалы подготовки', url: 'https://example.com/preparation' }],
    items: [{ id: 'p1', kind: 'question', text: 'Какой результат нужен команде?', status: 'open' },
      { id: 'p2', kind: 'risk', text: 'Для проверки нужны исходные документы.', status: 'resolved' }],
    score: { total: 2, resolved: 1, by_kind: {} } };
  const payload = { transcript: { meeting_id: 'fixture', meeting: 'Проверка интерфейса', status: 'recording', live: true,
    started_at: '2026-09-30T10:00:00Z', updated_at: '2026-09-30T10:02:00Z', latest_age_seconds: 1, segments: [], speakers: [] },
    copilot: { messages: [], busy: false, analysis: { state: 'idle' } }, call_plan: plan, journal, frames: [], meeting_chat: [], project: {} };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/status')) {
      const change = route.request().postDataJSON();
      const items = url.pathname.includes('call-plan') ? plan.items : journal;
      items.find(item => item.id === change.item_id).status = change.status;
      return route.fulfill({ json: { ok: true, journal, call_plan: plan } });
    }
    return route.fulfill({ json: url.pathname === '/api/state' ? payload : { ok: true, skipped: true } });
  });
  await page.goto(process.env.CALL_BOARD_URL || 'http://127.0.0.1:43123');
  await page.locator('.board-item').first().waitFor();
  assert.equal(await page.locator('.board-column:visible').count(), 3);
  assert.equal(await page.locator('#call-board').getByText('USER_QUERY_MUST_NOT_APPEAR').count(), 0);
  const widths = await page.evaluate(() => ({ left: document.querySelector('.transcript-pane').getBoundingClientRect().width,
    right: document.querySelector('.copilot-pane').getBoundingClientRect().width,
    overflow: document.documentElement.scrollWidth > innerWidth }));
  assert(widths.right > widths.left * 2);
  assert.equal(widths.overflow, false);
  await page.locator('.board-column.mine select').last().selectOption('resolved');
  await page.waitForTimeout(100);
  assert.equal(journal.find(item => item.id === 'a').status, 'resolved');
  await page.locator('.board-column.risks select').first().selectOption('open');
  await page.screenshot({ path: '/tmp/meeting-call-board-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: '/tmp/meeting-call-board-laptop.png', fullPage: true });
  await page.locator('[data-language="en"]').click();
  await page.getByRole('heading', { name: 'Questions to ask' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/meeting-call-board-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(errors.length, 0, errors.join('\n'));
  await browser.close();
  console.log('Call board: three simultaneous registers, status control, RU/EN, desktop/mobile and no JS errors: OK');
})().catch(error => { console.error(error); process.exit(1); });
