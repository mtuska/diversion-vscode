import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDay, formatRelative } from '../../src/util/dates';

// An explicit locale keeps these deterministic wherever they run; production
// passes undefined so Intl picks up the user's system locale.
const EN = 'en-US';
const DE = 'de-DE';

describe('formatDay', () => {
  // `new Date('2026-07-11')` is UTC midnight, which renders as July 10 in any
  // negative-offset timezone. Parsing components into a local Date is the
  // whole point of this function.
  it('does not shift a date-only string across the timezone boundary', () => {
    expect(formatDay('2026-07-11', EN)).toBe('Jul 11, 2026');
  });

  it('follows the locale', () => {
    expect(formatDay('2026-07-11', DE)).toBe('11.07.2026');
  });

  it('falls through to timestamp handling for a full ISO value', () => {
    expect(formatDay('2026-07-11T15:30:00Z', EN)).toMatch(/2026/);
  });

  it('returns the input unchanged when it cannot be parsed', () => {
    expect(formatDay('not a date', EN)).toBe('not a date');
    expect(formatDay(undefined)).toBe('');
  });
});

describe('formatDateTime', () => {
  it('renders date and time in the given locale', () => {
    const out = formatDateTime('2026-07-11T15:30:00Z', EN);
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/\d:\d\d/);
  });

  it('never yields Invalid Date', () => {
    expect(formatDateTime('garbage', EN)).toBe('garbage');
    expect(formatDateTime('')).toBe('');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-07-11T12:00:00Z');

  it('describes recent points in time', () => {
    expect(formatRelative('2026-07-11T11:30:00Z', EN, now)).toBe('30 minutes ago');
    expect(formatRelative('2026-07-11T09:00:00Z', EN, now)).toBe('3 hours ago');
    expect(formatRelative('2026-07-08T12:00:00Z', EN, now)).toBe('3 days ago');
  });

  it('switches to months past a month', () => {
    expect(formatRelative('2026-05-11T12:00:00Z', EN, now)).toBe('2 months ago');
  });

  // Past a year "13 months ago" is worse than a date.
  it('falls back to an absolute date beyond a year', () => {
    expect(formatRelative('2024-01-05T12:00:00Z', EN, now)).toBe('Jan 5, 2024');
  });

  it('passes unparseable input through', () => {
    expect(formatRelative('whenever', EN, now)).toBe('whenever');
  });
});
