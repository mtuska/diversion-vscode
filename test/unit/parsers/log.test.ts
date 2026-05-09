import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseLogOneline, parseLogFull } from '../../../src/diversion/parsers/log';

const FIX = path.resolve(__dirname, '../../fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

describe('parseLogOneline', () => {
  it('parses oneline output', () => {
    const r = parseLogOneline(read('log-oneline.txt'));
    expect(r).toHaveLength(5);
    expect(r[0]).toEqual({ id: 'dv.commit.40', subject: 'TEST2' });
    expect(r[2]?.subject).toContain('stagger updates');
  });

  it('returns [] for empty input', () => {
    expect(parseLogOneline('')).toEqual([]);
  });
});

describe('parseLogFull', () => {
  it('parses ISO-date full log', () => {
    const r = parseLogFull(read('log-full-iso.txt'));
    expect(r).toHaveLength(3);

    expect(r[0]).toMatchObject({
      id: 'dv.commit.40',
      authorName: 'A. Sample',
      authorEmail: 'author@example.com',
      date: '2026-04-11T20:42:03Z',
      message: 'TEST2',
    });
    expect(r[0]?.refs).toContain('dv.branch.1');

    expect(r[1]).toMatchObject({
      id: 'dv.commit.38',
      merge: { refName: 'ai-tuska', commitId: 'dv.branch.5' },
    });

    expect(r[2]?.message).toBe(
      'Updated perception to stagger updates for the character so it doesn\'t happen on the same frame',
    );
  });
});
