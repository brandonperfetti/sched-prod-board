import { fetchIncidents, ack } from './api.js';
import { formatLocal } from './time.js';

/** How often the board refreshes itself while open (R4). */
export const REFRESH_MS = 2000;
/** A refresh that takes longer than this counts as failed, so a hung request cannot freeze the board silently. */
const TIMEOUT_MS = 8000;

const board = document.querySelector('[data-testid="board"]');
const list = document.querySelector('[data-testid="incident-list"]');
const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');
const error = document.querySelector('[data-testid="error"]');
const updated = document.querySelector('.updated');

/** Rows on screen by incident id, so a refresh updates them in place instead of rebuilding the list. */
const rows = new Map();
/** Acks this page has made, by incident id: they survive every refresh. */
const acked = new Map();

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function ackedMark(reply) {
  return el('span', { 'data-testid': 'acked', class: 'acked', tabindex: '-1' }, `acked ${formatLocal(reply.ackedAt)}`);
}

/** Acks one row. A failure stays on that row until its next try, so a refresh never hides it. */
async function onAck(id, button, rowError) {
  // Read focus before disabling: a disabled button drops it.
  const hadFocus = document.activeElement === button;
  button.disabled = true;
  button.textContent = 'Acking…';
  rowError.hidden = true;
  try {
    const reply = await ack(id);
    acked.set(id, reply);
    const mark = ackedMark(reply);
    button.replaceWith(mark);
    if (hadFocus) mark.focus();
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Ack';
    rowError.textContent = `Ack failed: ${err.message}`;
    rowError.hidden = false;
    if (hadFocus) button.focus();
  }
}

/** Writes an incident's fields into its row; a refresh calls it again when the API changes them. */
function fill(row, i) {
  row.className = `row ${i.severity}`;
  row.querySelector('.sev').textContent = i.severity;
  row.querySelector('.what').textContent = `${i.service} · ${i.region} · ${i.summary}`;
  const time = row.querySelector('time');
  time.setAttribute('datetime', i.openedAt);
  time.title = i.openedAt;
  time.textContent = formatLocal(i.openedAt);
}

function buildRow(i) {
  const row = el('li', { 'data-testid': 'incident-row', 'data-id': i.id });
  row.append(el('span', { class: 'id' }, i.id), el('span', { class: 'sev' }), el('span', { class: 'what' }), el('time'));
  const rowError = el('span', { class: 'ack-error', role: 'alert' });
  rowError.hidden = true;
  if (acked.has(i.id)) {
    row.append(ackedMark(acked.get(i.id)));
  } else {
    const button = el('button', { type: 'button', 'data-testid': 'ack', 'aria-label': `Ack ${i.id}` }, 'Ack');
    button.addEventListener('click', () => onAck(i.id, button, rowError));
    row.append(button);
  }
  row.append(rowError);
  fill(row, i);
  return row;
}

/** Newest first by openedAt (R1); the API's order breaks ties. */
function newestFirst(incidents) {
  return incidents
    .map((i, n) => ({ i, n, t: Date.parse(i.openedAt) }))
    .sort((a, b) => b.t - a.t || a.n - b.n)
    .map(({ i }) => i);
}

/**
 * Puts the list in the given order, reusing existing rows so acks and focus survive a refresh.
 * Every answer from the API is the whole current list, `since` included (measured 2026-11-12), so a row
 * missing from it is gone.
 */
export function render(incidents) {
  const ordered = newestFirst(incidents);
  const keep = new Set(ordered.map((i) => i.id));
  for (const [id, row] of rows) {
    if (!keep.has(id)) {
      row.remove();
      rows.delete(id);
    }
  }
  let before = list.firstElementChild;
  for (const i of ordered) {
    let row = rows.get(i.id);
    if (row) {
      fill(row, i);
    } else {
      row = buildRow(i);
      rows.set(i.id, row);
    }
    if (row !== before) list.insertBefore(row, before);
    before = row.nextElementSibling;
  }
  empty.hidden = ordered.length > 0;
}

function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let loaded = false;

async function refresh() {
  try {
    const page = await withTimeout(fetchIncidents());
    render(page.incidents);
    if (!loaded) {
      loaded = true;
      loader.remove();
      board.setAttribute('aria-busy', 'false');
    }
    error.hidden = true;
    updated.textContent = `updated ${formatLocal(page.updatedAt, undefined, undefined, true)}`;
  } catch (err) {
    error.textContent = `Could not load incidents: ${err.message}. Retrying.`;
    error.hidden = false;
  } finally {
    setTimeout(refresh, REFRESH_MS);
  }
}

refresh();
