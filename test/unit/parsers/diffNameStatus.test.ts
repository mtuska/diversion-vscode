import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseDiffNameStatus } from '../../../src/diversion/parsers/diffNameStatus';

const FIX = path.resolve(__dirname, '../../fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

describe('parseDiffNameStatus', () => {
  it('parses an added entry', () => {
    const result = parseDiffNameStatus(read('diff-name-status-added.txt'));
    expect(result).toEqual([{ kind: 'added', path: 'Plugins/UnrealClaude' }]);
  });

  it('parses a mixed M/A/D set', () => {
    const result = parseDiffNameStatus(read('diff-name-status-mixed.txt'));
    expect(result).toHaveLength(10);
    const counts = result.reduce<Record<string, number>>((acc, c) => {
      acc[c.kind] = (acc[c.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ modified: 5, added: 2, deleted: 3 });
    expect(result[0]).toEqual({
      kind: 'modified',
      path: 'Content/Main/Characters/BP_Core_Character.uasset',
    });
  });

  it('treats "no changes detected" as empty', () => {
    expect(parseDiffNameStatus(read('diff-no-changes.txt'))).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(parseDiffNameStatus('')).toEqual([]);
  });

  it('skips malformed lines silently', () => {
    expect(parseDiffNameStatus('garbage line\nA\tok/path\nfoo\n')).toEqual([
      { kind: 'added', path: 'ok/path' },
    ]);
  });
});
