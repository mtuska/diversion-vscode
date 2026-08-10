import { describe, expect, it } from 'vitest';
import { buildConflictText, diffToBlocks, hasConflictMarkers } from '../../src/diversion/mergeMarkers';

const L = (s: string): string[] => s.split('\n');

describe('diffToBlocks', () => {
  it('returns one common block when both sides match', () => {
    expect(diffToBlocks(L('a\nb\nc'), L('a\nb\nc'))).toEqual([
      { kind: 'common', lines: ['a', 'b', 'c'] },
    ]);
  });

  it('isolates a single changed line, keeping the rest common', () => {
    expect(diffToBlocks(L('a\nMINE\nc'), L('a\nTHEIRS\nc'))).toEqual([
      { kind: 'common', lines: ['a'] },
      { kind: 'conflict', ours: ['MINE'], theirs: ['THEIRS'] },
      { kind: 'common', lines: ['c'] },
    ]);
  });

  it('produces separate blocks for edits at opposite ends', () => {
    const blocks = diffToBlocks(L('X\nb\nc\nd\nY'), L('1\nb\nc\nd\n2'));
    expect(blocks).toEqual([
      { kind: 'conflict', ours: ['X'], theirs: ['1'] },
      { kind: 'common', lines: ['b', 'c', 'd'] },
      { kind: 'conflict', ours: ['Y'], theirs: ['2'] },
    ]);
  });

  it('treats a pure insertion as one conflict with an empty side', () => {
    expect(diffToBlocks(L('a\nb'), L('a\nnew\nb'))).toEqual([
      { kind: 'common', lines: ['a'] },
      { kind: 'conflict', ours: [], theirs: ['new'] },
      { kind: 'common', lines: ['b'] },
    ]);
  });

  it('handles one side being empty', () => {
    expect(diffToBlocks([], L('a\nb'))).toEqual([
      { kind: 'conflict', ours: [], theirs: ['a', 'b'] },
    ]);
  });
});

describe('buildConflictText', () => {
  it('wraps only the differing region in markers', () => {
    const { text, conflictCount } = buildConflictText(
      'a\nMINE\nc\n', 'a\nTHEIRS\nc\n', { ours: 'Current', theirs: 'Incoming' },
    );
    expect(conflictCount).toBe(1);
    expect(text).toBe(
      'a\n<<<<<<< Current\nMINE\n=======\nTHEIRS\n>>>>>>> Incoming\nc\n',
    );
  });

  it('counts every block so the caller can report the real workload', () => {
    const { conflictCount } = buildConflictText(
      'X\nb\nY\n', '1\nb\n2\n', { ours: 'Current', theirs: 'Incoming' },
    );
    expect(conflictCount).toBe(2);
  });

  // Rewriting a CRLF file as LF would surface as a whole-file change in the
  // next `dv diff`, swamping the actual resolution.
  it('preserves CRLF line endings', () => {
    const { text } = buildConflictText(
      'a\r\nMINE\r\n', 'a\r\nTHEIRS\r\n', { ours: 'C', theirs: 'I' },
    );
    expect(text).toBe('a\r\n<<<<<<< C\r\nMINE\r\n=======\r\nTHEIRS\r\n>>>>>>> I\r\n');
  });

  it('preserves the absence of a trailing newline', () => {
    const { text } = buildConflictText('a\nMINE', 'a\nTHEIRS', { ours: 'C', theirs: 'I' });
    expect(text.endsWith('>>>>>>> I')).toBe(true);
  });

  it('emits nothing but content when the sides are identical', () => {
    const { text, conflictCount } = buildConflictText('same\n', 'same\n', { ours: 'C', theirs: 'I' });
    expect(conflictCount).toBe(0);
    expect(text).toBe('same\n');
  });
});

describe('hasConflictMarkers', () => {
  it('detects an in-progress resolution', () => {
    expect(hasConflictMarkers('a\n<<<<<<< Current\nx\n=======\ny\n>>>>>>> Incoming\n')).toBe(true);
  });

  it('does not fire on ordinary text', () => {
    expect(hasConflictMarkers('a\nb\nc\n')).toBe(false);
    expect(hasConflictMarkers('const x = a >>> b;\n')).toBe(false);
  });
});
