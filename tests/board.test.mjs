// Board tests: the built page (dist/) against a mocked incident API, in a real Chromium.
// Run: npm test  (builds dist-test/ with a test API first)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const API = 'https://api.test/api';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
let server;
let origin;
let browser;

before(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      const body = await readFile(join('dist-test', path === '/' ? 'index.html' : path));
      res.writeHead(200, { 'content-type': TYPES[extname(path) || '.html'] ?? 'text/plain' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

const inc = (id, openedAt, summary = 'webhook retries piling up') => ({
  id,
  service: 'booking-api',
  region: 'eu-west',
  summary,
  severity: 'sev2',
  openedAt,
});

/** A page whose API answers from `pages` in turn (the last one repeats); records every request. */
async function open({ pages, locale = 'en-US', timezoneId = 'UTC', delayFirst = 0, failFirst = false, failAck = false, delayAt = {} }) {
  const context = await browser.newContext({ locale, timezoneId });
  const page = await context.newPage();
  const calls = { incidents: [], ack: [], lastCursor: null };
  let n = 0;
  await page.route(`${API}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/incidents')) {
      const k = n++;
      calls.incidents.push(url);
      if (k === 0 && delayFirst) await new Promise((r) => setTimeout(r, delayFirst));
      if (delayAt[k]) await new Promise((r) => setTimeout(r, delayAt[k]));
      if (k === 0 && failFirst) return route.fulfill({ status: 500, body: 'boom' });
      const incidents = pages[Math.min(k, pages.length - 1)];
      calls.lastCursor = `c${k}`;
      return route.fulfill({ json: { updatedAt: new Date().toISOString(), incidents, cursor: `c${k}` } });
    }
    if (url.pathname.endsWith('/ack')) {
      calls.ack.push({ url, latest: calls.lastCursor });
      if (failAck) return route.fulfill({ status: 503, body: 'ack store down' });
      const id = url.searchParams.get('id');
      return route.fulfill({ json: { id, ackedAt: '2026-11-12T17:40:00.000Z', receipt: `r-${id}` } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(origin);
  return { page, calls, context };
}

const ids = (page) => page.$$eval('[data-testid="incident-row"]', (rs) => rs.map((r) => r.dataset.id));

test('a loader shows until incidents load, then the list (SCHED-4512)', async () => {
  const { page, context } = await open({ pages: [[inc('INC-1', '2026-11-12T17:00:00Z')]], delayFirst: 800 });
  assert.equal(await page.isVisible('[data-testid="loader"]'), true);
  await page.waitForSelector('[data-testid="incident-row"]');
  assert.equal(await page.$('[data-testid="loader"]'), null);
  await context.close();
});

test('an empty night shows the empty state, not a blank board', async () => {
  const { page, context } = await open({ pages: [[]] });
  await page.waitForSelector('[data-testid="empty"]:not([hidden])');
  assert.equal(await page.$('[data-testid="loader"]'), null);
  await context.close();
});

test('the list holds still: a new incident waits behind the N new bar, and the bar brings it in on top (product 2026-11-12)', async () => {
  const first = [inc('INC-2', '2026-11-12T17:10:00Z'), inc('INC-1', '2026-11-12T17:00:00Z')];
  const second = [inc('INC-3', '2026-11-12T17:20:00Z'), ...first];
  const { page, calls, context } = await open({ pages: [first, second] });
  await page.waitForSelector('[data-testid="incident-row"]');
  assert.equal(await page.isHidden('[data-testid="new-bar"]'), true);
  const y = () => page.$eval('[data-id="INC-1"] [data-testid="ack"]', (b) => b.getBoundingClientRect().y);
  const y0 = await y();
  await page.$eval('[data-id="INC-1"]', (r) => (r.dataset.marker = 'same-node'));
  await page.waitForSelector('[data-testid="new-bar"]:visible', { timeout: 4000 });
  assert.equal(await page.textContent('[data-testid="new-bar"]'), '1 new incident · show');
  assert.deepEqual(await ids(page), ['INC-2', 'INC-1'], 'no row is added while the list is on screen');
  assert.equal(await y(), y0, 'the bar appearing moves no row');
  assert.ok(calls.incidents.length >= 2);
  await page.click('[data-testid="new-bar"]');
  assert.deepEqual(await ids(page), ['INC-3', 'INC-2', 'INC-1']);
  assert.equal(await page.isHidden('[data-testid="new-bar"]'), true);
  assert.equal(await page.$eval('[data-id="INC-1"]', (r) => r.dataset.marker), 'same-node');
  assert.notEqual(await page.$('[data-id="INC-3"] [data-testid="ack"]'), null, 'the new top row has its Ack');
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-testid="incident-row"]')?.dataset.id), 'INC-3');
  await context.close();
});

test('an Ack aimed while new incidents arrive lands on the row aimed at', async () => {
  const first = [inc('INC-3', '2026-11-12T17:20:00Z'), inc('INC-2', '2026-11-12T17:10:00Z'), inc('INC-1', '2026-11-12T17:00:00Z')];
  const second = [inc('INC-5', '2026-11-12T17:40:00Z'), inc('INC-4', '2026-11-12T17:30:00Z'), ...first];
  const { page, calls, context } = await open({ pages: [first, second] });
  await page.waitForSelector('[data-id="INC-1"] [data-testid="ack"]');
  const box = await page.$eval('[data-id="INC-1"] [data-testid="ack"]', (b) => {
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.waitForSelector('[data-testid="new-bar"]:visible', { timeout: 4000 });
  await page.mouse.click(box.x, box.y);
  await page.waitForSelector('[data-id="INC-1"] [data-testid="acked"]');
  assert.deepEqual(calls.ack.map((a) => a.url.searchParams.get('id')), ['INC-1']);
  assert.equal(await page.textContent('[data-testid="new-bar"]'), '2 new incidents · show');
  await context.close();
});

test('the board refreshes itself every 2 seconds (SCHED-4513)', async () => {
  const { page, calls, context } = await open({ pages: [[inc('INC-1', '2026-11-12T17:00:00Z')]] });
  await page.waitForSelector('[data-testid="incident-row"]');
  const start = calls.incidents.length;
  await page.waitForTimeout(4500);
  const made = calls.incidents.length - start;
  assert.ok(made >= 2 && made <= 3, `expected 2–3 refreshes in 4.5 s, got ${made}`);
  await context.close();
});

test('Ack acks that incident with the latest cursor and the mark survives refreshes (SCHED-4511)', async () => {
  const rows = [inc('INC-2', '2026-11-12T17:10:00Z'), inc('INC-1', '2026-11-12T17:00:00Z')];
  const { page, calls, context } = await open({ pages: [rows] });
  await page.click('[data-id="INC-1"] [data-testid="ack"]');
  await page.waitForSelector('[data-id="INC-1"] [data-testid="acked"]');
  assert.equal(calls.ack.length, 1);
  assert.equal(calls.ack[0].url.searchParams.get('id'), 'INC-1');
  assert.equal(calls.ack[0].url.searchParams.get('cursor'), calls.ack[0].latest);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'acked');
  assert.equal(await page.$('[data-id="INC-2"] [data-testid="acked"]'), null);
  await page.waitForTimeout(2500);
  assert.notEqual(await page.$('[data-id="INC-1"] [data-testid="acked"]'), null);
  assert.equal(await page.$('[data-id="INC-1"] [data-testid="ack"]'), null);
  await context.close();
});

test('times show in the viewer zone and order, with full UTC in datetime (SCHED-4514)', async () => {
  const at = '2026-11-12T03:03:00.000Z';
  const berlin = await open({ pages: [[inc('INC-1', at)]], locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const b = await berlin.page.waitForSelector('[data-id="INC-1"] time');
  assert.equal(await b.getAttribute('datetime'), at);
  assert.match(await b.textContent(), /^12\.11\., 04:03/);
  await berlin.context.close();

  const auckland = await open({ pages: [[inc('INC-1', at)]], locale: 'en-NZ', timezoneId: 'Pacific/Auckland' });
  const a = await auckland.page.waitForSelector('[data-id="INC-1"] time');
  assert.match(await a.textContent(), /^12\/11, 0?4:03\s?pm NZDT/i);
  await auckland.context.close();

  const london = await open({ pages: [[inc('INC-1', at)]], locale: 'en-GB', timezoneId: 'Europe/London' });
  const l = await london.page.waitForSelector('[data-id="INC-1"] time');
  assert.match(await l.textContent(), /^12\/11, 03:03/);
  await london.context.close();
});

test('incident text is shown as text, never run as HTML', async () => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  const { page, context } = await open({ pages: [[inc('INC-1', '2026-11-12T17:00:00Z', evil)]] });
  await page.waitForSelector('[data-testid="incident-row"]');
  assert.equal(await page.$('[data-testid="incident-row"] img'), null);
  assert.ok((await page.textContent('[data-id="INC-1"] .what')).includes(evil));
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  await context.close();
});

test('a failed load says so and recovers on the next refresh', async () => {
  const { page, context } = await open({ pages: [[inc('INC-1', '2026-11-12T17:00:00Z')]], failFirst: true });
  await page.waitForSelector('[data-testid="error"]:not([hidden])');
  await page.waitForSelector('[data-testid="incident-row"]', { timeout: 4000 });
  assert.equal(await page.isHidden('[data-testid="error"]'), true);
  await context.close();
});

test('the page names its build in the head and the footer (R6)', async () => {
  const { page, context } = await open({ pages: [[]] });
  const meta = await page.getAttribute('meta[name="build"]', 'content');
  assert.match(meta, /^[0-9a-f]{40}$/);
  assert.equal(await page.textContent('[data-testid="build-sha"]'), meta);
  await context.close();
});

test('a refresh updates a row in place; a gone incident stays until the bar is clicked', async () => {
  const first = [inc('INC-2', '2026-11-12T17:10:00Z'), inc('INC-1', '2026-11-12T17:00:00Z')];
  const second = [{ ...first[0], severity: 'sev1', summary: 'webhooks down' }];
  const { page, context } = await open({ pages: [first, second] });
  await page.waitForSelector('[data-id="INC-1"]');
  await page.waitForSelector('[data-testid="new-bar"]:visible', { timeout: 4000 });
  assert.equal(await page.textContent('[data-id="INC-2"] .sev'), 'sev1');
  assert.match(await page.textContent('[data-id="INC-2"] .what'), /webhooks down/);
  assert.match(await page.getAttribute('[data-id="INC-2"]', 'class'), /\bsev1\b/);
  assert.notEqual(await page.$('[data-id="INC-1"]'), null, 'the gone row holds until the bar');
  assert.equal(await page.textContent('[data-testid="new-bar"]'), 'list changed · show');
  await page.click('[data-testid="new-bar"]');
  assert.equal(await page.$('[data-id="INC-1"]'), null);
  await context.close();
});

test('a failed ack stays on its row through refreshes and the button comes back', async () => {
  const { page, context } = await open({ pages: [[inc('INC-1', '2026-11-12T17:00:00Z')]], failAck: true });
  await page.click('[data-id="INC-1"] [data-testid="ack"]');
  await page.waitForSelector('[data-id="INC-1"] .ack-error:not([hidden])');
  await page.waitForTimeout(4500);
  assert.equal(await page.isVisible('[data-id="INC-1"] .ack-error'), true);
  assert.match(await page.textContent('[data-id="INC-1"] .ack-error'), /Ack failed: ack: 503/);
  assert.equal(await page.isEnabled('[data-id="INC-1"] [data-testid="ack"]'), true);
  assert.equal(await page.$('[data-id="INC-1"] [data-testid="acked"]'), null);
  await context.close();
});

test('a slow refresh shows an error but is awaited, so refreshes never overlap and the cursor only moves forward', async () => {
  const rows = [inc('INC-1', '2026-11-12T17:00:00Z')];
  const { page, calls, context } = await open({ pages: [rows], delayAt: { 1: 9000 } });
  await page.waitForSelector('[data-testid="incident-row"]');
  await page.waitForSelector('[data-testid="error"]:not([hidden])', { timeout: 12000 });
  assert.equal(calls.incidents.length, 2, 'no new refresh while the slow one is pending');
  await page.waitForSelector('[data-testid="error"]', { state: 'hidden', timeout: 4000 });
  await page.waitForTimeout(2500);
  await page.click('[data-id="INC-1"] [data-testid="ack"]');
  await page.waitForSelector('[data-id="INC-1"] [data-testid="acked"]');
  assert.equal(calls.ack[0].url.searchParams.get('cursor'), calls.ack[0].latest);
  await context.close();
});

test('an unchanged refresh changes nothing in the list', async () => {
  const rows = [inc('INC-2', '2026-11-12T17:10:00Z'), inc('INC-1', '2026-11-12T17:00:00Z')];
  const { page, context } = await open({ pages: [rows] });
  await page.waitForSelector('[data-testid="incident-row"]');
  await page.evaluate(() => {
    window.__mutations = 0;
    new MutationObserver((m) => (window.__mutations += m.length)).observe(document.querySelector('[data-testid="incident-list"]'), {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
  });
  await page.waitForTimeout(4500);
  assert.equal(await page.evaluate(() => window.__mutations), 0);
  await context.close();
});
