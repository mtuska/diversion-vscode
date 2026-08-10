/**
 * Locale-aware rendering for the dates we show in the UI.
 *
 * Diversion's own clients follow the system locale now, and an ISO timestamp
 * in a tooltip is a poor thing to read at a glance regardless. Machine-facing
 * surfaces (the MCP and language-model tools) deliberately keep raw ISO — a
 * model wants an unambiguous timestamp, not a localized one.
 *
 * Every function returns the input unchanged when it can't parse it. `dv`'s
 * text output is an unstable surface, and a stale date is far better than
 * "Invalid Date" in a blame gutter.
 */

/** `YYYY-MM-DD` with nothing after it — what `dv annotate` prints. */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Format a date-only string.
 *
 * Parsed component-wise into a *local* Date rather than through
 * `new Date('2026-07-11')`, which the spec says to read as UTC midnight — in
 * any negative-offset timezone that renders as the previous day, so a naive
 * implementation shows every blame line one day early in the Americas.
 */
export function formatDay(raw: string | undefined, locale?: string): string {
  if (!raw) return '';
  const m = DATE_ONLY_RE.exec(raw.trim());
  if (!m) return formatDateTime(raw, locale);
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

/** Format a full timestamp (ISO-8601 or anything `Date.parse` accepts). */
export function formatDateTime(raw: string | undefined, locale?: string): string {
  if (!raw) return '';
  const ms = Date.parse(raw.trim());
  if (Number.isNaN(ms)) return raw;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "3 days ago" style, for surfaces where the age matters more than the
 * timestamp. Falls back to an absolute date past a year, where relative
 * phrasing stops being informative.
 */
export function formatRelative(raw: string | undefined, locale?: string, now = Date.now()): string {
  if (!raw) return '';
  const ms = Date.parse(raw.trim());
  if (Number.isNaN(ms)) return raw;
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs >= 365 * DAY) {
    // Date only — at this distance the time of day is noise.
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(ms);
  }

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < HOUR) return rtf.format(Math.round(diff / MINUTE), 'minute');
  if (abs < DAY) return rtf.format(Math.round(diff / HOUR), 'hour');
  if (abs < 30 * DAY) return rtf.format(Math.round(diff / DAY), 'day');
  return rtf.format(Math.round(diff / (30 * DAY)), 'month');
}
