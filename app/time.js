/**
 * An ISO time in the viewer's own zone and locale order (R5): a Berlin viewer gets day before month,
 * an Auckland viewer gets their own zone. The full UTC value stays in the <time datetime> attribute.
 * With `clock`, only the time of day with seconds (for "updated …").
 */
export function formatLocal(iso, locales = navigator.languages, timeZone, clock = false) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = clock
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' };
  return new Intl.DateTimeFormat(locales, { ...parts, ...(timeZone ? { timeZone } : {}) }).format(date);
}
