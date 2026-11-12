/**
 * An ISO time in the viewer's own zone and locale order (R5): a Berlin viewer gets day before month,
 * an Auckland viewer gets their own zone. The full UTC value stays in the <time datetime> attribute.
 */
export function formatLocal(iso, locales = navigator.languages, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locales, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}
