import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseUnifiedDiff, splitMultiFileDiff } from '../../../src/diversion/parsers/unifiedDiff';
import { reverseApply } from '../../../src/diversion/reverseApply';

const FIX = path.resolve(__dirname, '../../fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

describe('parseUnifiedDiff', () => {
  it('parses single hunk', () => {
    const r = parseUnifiedDiff(read('unified-diff-simple.txt'));
    expect(r.binary).toBe(false);
    expect(r.basePath).toBe('src/foo.ts');
    expect(r.newPath).toBe('src/foo.ts');
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0]).toMatchObject({
      baseStart: 1, baseCount: 5, newStart: 1, newCount: 6,
    });
  });

  it('parses multiple hunks', () => {
    const r = parseUnifiedDiff(read('unified-diff-multi-hunk.txt'));
    expect(r.hunks).toHaveLength(2);
    expect(r.hunks[1]?.newStart).toBe(10);
  });

  it('flags binary', () => {
    const r = parseUnifiedDiff('Binary files a/foo.bin and b/foo.bin differ\n');
    expect(r.binary).toBe(true);
    expect(r.hunks).toEqual([]);
  });

  it('returns empty result for empty input', () => {
    const r = parseUnifiedDiff('');
    expect(r.hunks).toEqual([]);
    expect(r.binary).toBe(false);
  });
});

describe('splitMultiFileDiff', () => {
  it('splits a 3-file diff', () => {
    const text = fs.readFileSync(path.join(FIX, 'multi-file-diff.txt'), 'utf8');
    const m = splitMultiFileDiff(text);
    expect([...m.keys()]).toEqual(['Source/A.cpp', 'Source/B.cpp', 'Documentation/CLAUDE.md']);

    const aChunk = m.get('Source/A.cpp')!;
    expect(aChunk).toContain('diff --git a/Source/A.cpp b/Source/A.cpp');
    expect(aChunk).toContain('-old-a');
    expect(aChunk).not.toContain('only-new'); // belongs to B

    const bDiff = parseUnifiedDiff(m.get('Source/B.cpp')!);
    expect(bDiff.hunks).toHaveLength(1);
    expect(bDiff.newPath).toBe('Source/B.cpp');
  });

  it('returns empty map for non-diff input', () => {
    expect(splitMultiFileDiff('')).toEqual(new Map());
    expect(splitMultiFileDiff('No changes detected\n')).toEqual(new Map());
  });
});

describe('reverseApply', () => {
  it('recovers base content from a single-hunk diff', () => {
    const diff = parseUnifiedDiff(read('unified-diff-simple.txt'));
    const working = [
      'line one',
      'line two',
      'new three',
      'inserted four',
      'line four',
      'line five',
    ].join('\n') + '\n';
    const expected = [
      'line one',
      'line two',
      'old three',
      'line four',
      'line five',
    ].join('\n') + '\n';
    expect(reverseApply(working, diff)).toBe(expected);
  });

  it('recovers base content with multiple hunks (applied right-to-left)', () => {
    const diff = parseUnifiedDiff(read('unified-diff-multi-hunk.txt'));
    const working = [
      'alpha',  // 1
      'BETA',   // 2 (was beta)
      'gamma',  // 3
      'four',   // 4 — context outside hunk 1's window
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'delta',     // 10
      'epsilon',   // 11
      'epsilon-prime', // 12 — added
      'zeta',      // 13
      'eta',       // 14
    ].join('\n') + '\n';
    const expected = [
      'alpha',
      'beta',
      'gamma',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'delta',
      'epsilon',
      'zeta',
      'eta',
    ].join('\n') + '\n';
    expect(reverseApply(working, diff)).toBe(expected);
  });

  it('returns undefined for binary diffs', () => {
    const diff = parseUnifiedDiff('Binary files a/foo and b/foo differ\n');
    expect(reverseApply('whatever', diff)).toBeUndefined();
  });

  it('returns the input unchanged when there are no hunks', () => {
    const diff = parseUnifiedDiff('');
    expect(reverseApply('hello', diff)).toBe('hello');
  });

  it('returns undefined when working content does not match the diff', () => {
    const diff = parseUnifiedDiff(read('unified-diff-simple.txt'));
    expect(reverseApply('totally different content\n', diff)).toBeUndefined();
  });
});
