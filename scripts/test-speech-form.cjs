// speech.js key field: a rejected stored key can be replaced (MEETONTRACK-78), and
// polling during a download keeps the mounted form and the key being typed (MEETONTRACK-79).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.textContent = ''; this.className = ''; this.hidden = false; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  all() { return this.children.flatMap(child => [child, ...child.all()]); }
  querySelector(selector) { return this.all().find(item => item.className === selector.slice(1)) || null; }
}
const ids = {};
const document = {documentElement: {lang: 'en'}, getElementById: id => (ids[id] ||= new El('div')), createElement: tag => new El(tag)};
const engine = {id: 'openai', label: 'OpenAI', kind: 'cloud', available: true, needs_key: true, has_key: true, model_entry: 'list',
  models: [], listing: {error: 'HTTP 401 from OpenAI'}};
const local = {id: 'local', label: 'Local', kind: 'local', available: true, needs_key: false, model_entry: 'list',
  models: [{id: 'm', label: 'M', available: true, downloaded: false, languages: ['en'], download_bytes: 1e6}]};
let downloads = [{model: 'm', state: 'running', fraction: 0.5}];
const posts = [];
const fetch = async (path, init) => {
  if (init?.method === 'POST') posts.push([path, JSON.parse(init.body)]);
  const body = path.startsWith('/api/stt/options') ? {ok: true, engines: [engine, local]}
    : path === '/api/stt' ? {ok: true, choice: {state: 'needs_choice', choice: {engine: 'openai'}}, downloads, retranscribe: []}
    : {ok: true};
  return {ok: true, json: async () => body};
};
const intervals = [];
const context = {document, fetch, MutationObserver: class { observe() {} }, setInterval: fn => intervals.push(fn) || 1, clearInterval() {},
  plainError: error => String(error?.message || error), apiError: result => new Error(result.error), Intl};
ids['getting-started'] = new El('section');
vm.runInNewContext(fs.readFileSync('copilot/web/speech.js', 'utf8'), context);

const inputs = () => ids['speech-choice'].all().filter(item => item.tagName === 'input');
const buttons = () => ids['speech-choice'].all().filter(item => item.tagName === 'button');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

(async () => {
  ids['getting-started'].listeners = {};
  // The MutationObserver stub never fires: start discovery the way an open page does.
  context.document.getElementById('speech-refresh').listeners.click[0]();
  await settle(); await settle();
  // MEETONTRACK-78: has_key true, but the provider rejected it, so the key field is offered.
  const key = inputs().find(item => item.type === 'password');
  assert.ok(key, 'a rejected key can be replaced');
  key.value = 'sk-typed'; key.listeners.input[0]();
  // MEETONTRACK-79: the 1.5 s poll while a download runs keeps the mounted input and its value.
  assert.equal(intervals.length, 1, 'a running download is polled');
  await intervals[0]();
  assert.equal(inputs().find(item => item.type === 'password'), key, 'polling keeps the mounted key field');
  // A full redraw (a finished download reloads) still shows what was typed.
  context.document.getElementById('speech-refresh').listeners.click[0]();
  await settle(); await settle();
  assert.equal(inputs().find(item => item.type === 'password').value, 'sk-typed', 'a redraw keeps the typed key');
  buttons().find(item => item.textContent === 'Save key').listeners.click[0]();
  await settle();
  assert.deepEqual(posts.find(([path]) => path === '/api/stt/key'), ['/api/stt/key', {engine: 'openai', key: 'sk-typed'}]);
  // A key the provider accepted is not asked for again.
  engine.listing.error = '';
  context.document.getElementById('speech-refresh').listeners.click[0]();
  await settle(); await settle();
  assert.equal(inputs().find(item => item.type === 'password'), undefined, 'an accepted key is not asked for');
  console.log('speech form ok');
})().catch(error => { console.error(error); process.exit(1); });
