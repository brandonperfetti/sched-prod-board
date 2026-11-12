import { fetchIncidents, ack } from './api.js';
import { formatLocal } from './time.js';

/** How often the board refreshes itself while open (R4). */
export const REFRESH_MS = 2000;
/** A refresh slower than this shows an error, so a hung request cannot freeze the board silently. */
const TIMEOUT_MS = 8000;

const board = document.querySelector('[data-testid="board"]');
const list = document.querySelector('[data-testid="incident-list"]');
const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');
const error = document.querySelector('[data-testid="error"]');
const updated = document.querySelector('.updated');
const newBar = document.querySelector('[data-testid="new-bar"]');

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

/** Acks in flight, by incident id: one request per incident, whichever row is on screen for it. */
const inFlight = new Set();
/** Incident ids in the API's latest answer; a row not in it is gone from the list. */
let listed = new Set();

const ackButtonOf = (id) => rows.get(id)?.querySelector('[data-testid="ack"]') ?? null;

/** Puts a row's Ack button in its state: open, in flight, or gone from the list. */
function setAckState(button, state) {
  set(button, 'disabled', state !== 'open');
  set(button, 'textContent', { open: 'Ack', inFlight: 'Acking…', gone: 'Gone from list' }[state]);
}

/**
 * Acks one incident. The reply goes to the row on screen for it when it lands, which may be a row the bar
 * rebuilt meanwhile. A failure stays on that row until its next try, so a refresh never hides it.
 */
async function onAck(id) {
  if (inFlight.has(id) || acked.has(id)) return;
  const button = ackButtonOf(id);
  // Read focus before disabling: a disabled button drops it.
  const hadFocus = button !== null && document.activeElement === button;
  inFlight.add(id);
  if (button) setAckState(button, 'inFlight');
  const error = rows.get(id)?.querySelector('.ack-error');
  if (error) error.hidden = true;
  try {
    const reply = await ack(id);
    acked.set(id, reply);
    const current = ackButtonOf(id);
    if (current) {
      const mark = ackedMark(reply);
      current.replaceWith(mark);
      if (hadFocus) mark.focus();
    }
  } catch (err) {
    const current = ackButtonOf(id);
    if (current) {
      setAckState(current, listed.has(id) ? 'open' : 'gone');
      if (hadFocus) current.focus();
    }
    const rowError = rows.get(id)?.querySelector('.ack-error');
    if (rowError) {
      rowError.textContent = `Ack failed: ${err.message}`;
      rowError.hidden = false;
    }
  } finally {
    inFlight.delete(id);
  }
}

/**
 * A row whose incident left the API's list stays put until the bar (R1) but can no longer be acked; it comes
 * back to life if the incident returns. Every such row is marked, acked or not; an ack in flight is left alone.
 */
function markGone(row, gone) {
  row.classList.toggle('gone', gone);
  const button = row.querySelector('[data-testid="ack"]');
  if (!button || inFlight.has(row.dataset.id)) return;
  setAckState(button, gone ? 'gone' : 'open');
}

/** Sets a value only when it differs, so an unchanged refresh makes no DOM mutation (no live-region noise). */
function set(node, key, value) {
  if (node[key] !== value) node[key] = value;
}

/** Writes an incident's fields into its row; a refresh calls it again when the API changes them. */
function fill(row, i) {
  set(row, 'className', `row ${i.severity}`);
  set(row.querySelector('.sev'), 'textContent', i.severity);
  const what = `${i.service} · ${i.region} · ${i.summary}`;
  set(row.querySelector('.what'), 'textContent', what);
  set(row.querySelector('.what'), 'title', what);
  const time = row.querySelector('time');
  set(time, 'dateTime', i.openedAt);
  set(time, 'title', i.openedAt);
  set(time, 'textContent', formatLocal(i.openedAt));
}

function buildRow(i) {
  const row = el('li', { 'data-testid': 'incident-row', 'data-id': i.id, tabindex: '-1' });
  row.append(el('span', { class: 'id' }, i.id), el('span', { class: 'sev' }), el('span', { class: 'what' }), el('time'));
  const rowError = el('span', { class: 'ack-error', role: 'alert' });
  rowError.hidden = true;
  if (acked.has(i.id)) {
    row.append(ackedMark(acked.get(i.id)));
  } else {
    const button = el('button', { type: 'button', 'data-testid': 'ack', 'aria-label': `Ack ${i.id}` }, 'Ack');
    if (inFlight.has(i.id)) setAckState(button, 'inFlight');
    button.addEventListener('click', () => onAck(i.id));
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
 * Puts the whole list in order, reusing existing rows so acks and focus survive. Used on first load and when
 * on-call clicks the "N new" bar. Every answer from the API is the whole current list, `since` included
 * (measured 2026-11-12), so a row missing from it is gone.
 */
function apply(incidents) {
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
  pending = null;
  newBar.hidden = true;
}

/** The latest list while it differs from the one on screen; the bar applies it. */
let pending = null;
/** Set after the first successful load; until then a refresh draws the whole list. */
let loaded = false;

/**
 * Product's decision (2026-11-12): the list holds still while it is on screen. A refresh only rewrites the
 * rows already shown; new incidents wait behind the "N new" bar (and a gone row stays until then), so no
 * row moves under a pointer between aim and click.
 */
export function render(incidents) {
  listed = new Set(incidents.map((i) => i.id));
  if (!loaded) return apply(incidents);
  const latest = listed;
  const fresh = incidents.filter((i) => !rows.has(i.id)).length;
  const gone = [...rows.keys()].filter((id) => !latest.has(id)).length;
  for (const i of incidents) {
    if (!rows.has(i.id)) continue;
    fill(rows.get(i.id), i);
    markGone(rows.get(i.id), false);
  }
  for (const [id, row] of rows) if (!latest.has(id)) markGone(row, true);
  if (!fresh && !gone) {
    pending = null;
    newBar.hidden = true;
    return;
  }
  pending = incidents;
  set(newBar, 'textContent', fresh ? `${fresh} new ${fresh === 1 ? 'incident' : 'incidents'} · show` : 'list changed · show');
  newBar.hidden = false;
}

newBar.addEventListener('click', () => {
  if (!pending) return;
  apply(pending);
  // Focus the new top row itself, not its Ack: a repeated Enter on the bar must not ack anything.
  list.firstElementChild?.focus();
});


function showLoadError(message) {
  error.textContent = `Could not load incidents: ${message}. Retrying.`;
  error.hidden = false;
}

/**
 * One refresh at a time: the next starts only after this one settles, so the cursor only moves forward.
 * A slow answer shows an error after TIMEOUT_MS but is still awaited, never raced past.
 */
async function refresh() {
  const slow = setTimeout(() => showLoadError(`no answer in ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS);
  try {
    const page = await fetchIncidents();
    render(page.incidents);
    if (!loaded) {
      loaded = true;
      loader.remove();
      board.setAttribute('aria-busy', 'false');
    }
    error.hidden = true;
    const when = formatLocal(page.updatedAt ?? new Date().toISOString(), undefined, undefined, true);
    set(updated, 'textContent', `updated ${when}`);
  } catch (err) {
    showLoadError(err.message);
  } finally {
    clearTimeout(slow);
    setTimeout(refresh, REFRESH_MS);
  }
}

refresh();
