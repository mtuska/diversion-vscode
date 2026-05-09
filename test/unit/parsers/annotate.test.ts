import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAnnotation } from '../../../src/diversion/parsers/annotate';

const FIX = path.resolve(__dirname, '../../fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

describe('parseAnnotation', () => {
  it('parses header + continuation + uncommitted + new commit', () => {
    const r = parseAnnotation(read('annotate-mixed.txt'));
    expect(r.length).toBe(20);

    expect(r[0]).toMatchObject({
      lineNumber: 1,
      commitId: 'dv.commit.10',
      author: 'A. Sample',
      date: '2026-05-08',
      uncommitted: false,
      content: '# Sample.md — Project Context',
    });

    // Continuation: same commit, line 2, blank content
    expect(r[1]).toMatchObject({
      lineNumber: 2,
      commitId: 'dv.commit.10',
      author: 'A. Sample',
      uncommitted: false,
    });

    // Uncommitted line
    const uncommitted = r.find((a) => a.lineNumber === 18);
    expect(uncommitted).toMatchObject({
      commitId: 'uncommitted',
      uncommitted: true,
    });

    // After uncommitted, line 19 inherits — should still be flagged uncommitted
    const after = r.find((a) => a.lineNumber === 19);
    expect(after).toMatchObject({ commitId: 'uncommitted', uncommitted: true });

    // New commit on line 20
    const fresh = r.find((a) => a.lineNumber === 20);
    expect(fresh).toMatchObject({
      commitId: 'dv.commit.7',
      author: 'B. Sample',
      date: '2026-04-21',
      uncommitted: false,
    });
  });

  it('returns [] for empty input', () => {
    expect(parseAnnotation('')).toEqual([]);
  });
});
