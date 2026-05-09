import { describe, expect, it } from 'vitest';
import { parseLockList } from '../../../src/diversion/parsers/lock';

describe('parseLockList', () => {
  it('returns [] for empty/no-locks variants', () => {
    expect(parseLockList('No active locks\n')).toEqual([]);
    expect(parseLockList('No locks\n')).toEqual([]);
    expect(parseLockList('')).toEqual([]);
  });

  it('handles "Locked by ..." trailing form', () => {
    const r = parseLockList('Content/Hero.uasset - Locked by alice@example.com\n');
    expect(r).toEqual([
      { path: 'Content/Hero.uasset', holder: 'alice@example.com', raw: 'Content/Hero.uasset - Locked by alice@example.com' },
    ]);
  });

  it('handles "(holder)" trailing form', () => {
    const r = parseLockList('Content/Map.umap (alice@example.com)\n');
    expect(r[0]).toMatchObject({ path: 'Content/Map.umap', holder: 'alice@example.com' });
  });

  it('handles tab-separated columns', () => {
    const r = parseLockList('Content/A.uasset\talice\nContent/B.uasset\tbob\n');
    expect(r.map((l) => l.path)).toEqual(['Content/A.uasset', 'Content/B.uasset']);
    expect(r.map((l) => l.holder)).toEqual(['alice', 'bob']);
  });

  it('handles double-space columns', () => {
    const r = parseLockList('Content/A.uasset    alice@example.com\n');
    expect(r[0]).toMatchObject({ path: 'Content/A.uasset', holder: 'alice@example.com' });
  });

  it('skips header rows', () => {
    const r = parseLockList('PATH\tHOLDER\nContent/A.uasset\talice\n');
    expect(r.map((l) => l.path)).toEqual(['Content/A.uasset']);
  });

  it('falls back to whole-line-as-path when no holder pattern matches', () => {
    const r = parseLockList('Content/Loose.uasset\n');
    expect(r[0]).toEqual({ path: 'Content/Loose.uasset', holder: undefined, raw: 'Content/Loose.uasset' });
  });
});
