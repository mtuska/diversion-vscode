import { describe, expect, it } from 'vitest';
import { parseShelfList } from '../../../src/diversion/parsers/shelf';

describe('parseShelfList', () => {
  it('returns [] for the empty case', () => {
    expect(parseShelfList('No shelves found.\n')).toEqual([]);
    expect(parseShelfList('')).toEqual([]);
  });

  it('parses dv.shelf.<id> name form', () => {
    const r = parseShelfList('dv.shelf.abc123  wip-inventory   2026-05-09 14:00\n');
    expect(r).toEqual([
      { id: 'dv.shelf.abc123', name: 'wip-inventory', description: '2026-05-09 14:00', raw: r[0]!.raw },
    ]);
  });

  it('parses tab-separated form', () => {
    const r = parseShelfList('wip-inventory\t2026-05-09\nspike-ai\t2026-05-08\n');
    expect(r.map((s) => s.name)).toEqual(['wip-inventory', 'spike-ai']);
  });

  it('parses double-space columns', () => {
    const r = parseShelfList('wip-inventory    2026-05-09\n');
    expect(r[0]).toMatchObject({ name: 'wip-inventory', description: '2026-05-09' });
  });

  it('skips header rows', () => {
    const r = parseShelfList('NAME\tDATE\nwip-x\t2026-05-09\n');
    expect(r.map((s) => s.name)).toEqual(['wip-x']);
  });

  it('falls back to whole-line-as-name', () => {
    const r = parseShelfList('lonely-shelf\n');
    expect(r[0]).toEqual({ name: 'lonely-shelf', raw: 'lonely-shelf' });
  });
});
