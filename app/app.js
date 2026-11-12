import { fetchIncidents, ack } from './api.js';
import { formatLocal } from './time.js';

/** How often the board refreshes itself while open (R4). */
export const REFRESH_MS = 2000;

const board = document.querySelector('[data-testid="board"]');
const list = document.querySelector('[data-testid="incident-list"]');
const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');
const error = document.querySelector('[data-testid="error"]');

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
  return el('span', { 'data-testid': 'acked', class: 'acked' }, `acked ${formatLocal(reply.ackedAt)}`);
}

async function onAck(id, button) {
  button.disabled = true;
  button.textContent = 'Acking…';
  try {
    const reply = await ack(id);
    acked.set(id, reply);
    button.replaceWith(ackedMark(reply));
    error.hidden = true;
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Ack';
    showError(`Ack failed for ${id}: ${err.message}`);
  }
}

function buildRow(i) {
  const row = el('li', { 'data-testid': 'incident-row', 'data-id': i.id, class: `row ${i.severity}` });
  row.append(
    el('span', { class: 'id' }, i.id),
    el('span', { class: 'sev' }, i.severity),
    el('span', { class: 'what' }, `${i.service} · ${i.region} · ${i.summary}`),
    el('time', { datetime: i.openedAt, title: i.openedAt }, formatLocal(i.openedAt)),
  );
  if (acked.has(i.id)) {
    row.append(ackedMark(acked.get(i.id)));
  } else {
    const button = el('button', { type: 'button', 'data-testid': 'ack', 'aria-label': `Ack ${i.id}` }, 'Ack');
    button.addEventListener('click', () => onAck(i.id, button));
    row.append(button);
  }
  return row;
}

/** Newest first by openedAt (R1); the API's order breaks ties. */
function newestFirst(incidents) {
  return incidents
    .map((i, n) => ({ i, n, t: Date.parse(i.openedAt) }))
    .sort((a, b) => b.t - a.t || a.n - b.n)
    .map(({ i }) => i);
}

/** Puts the list in the given order, reusing existing rows so acks and focus survive a refresh. */
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
    if (!row) {
      row = buildRow(i);
      rows.set(i.id, row);
    }
    if (row !== before) list.insertBefore(row, before);
    before = row.nextElementSibling;
  }
  empty.hidden = ordered.length > 0;
}

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

let loaded = false;

async function refresh() {
  try {
    const page = await fetchIncidents();
    render(page.incidents);
    if (!loaded) {
      loaded = true;
      loader.remove();
      board.setAttribute('aria-busy', 'false');
    }
    error.hidden = true;
  } catch (err) {
    showError(`Could not load incidents: ${err.message}. Retrying.`);
  } finally {
    setTimeout(refresh, REFRESH_MS);
  }
}

refresh();
