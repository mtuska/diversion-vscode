import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseLogFull } from '../../../src/diversion/parsers/log';

const FIX = path.resolve(__dirname, '../../fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

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

  it('preserves paragraph breaks in multi-paragraph messages', () => {
    const r = parseLogFull(read('log-full-multiparagraph.txt'));
    expect(r).toHaveLength(2);

    const msg = r[0]!.message;
    expect(msg.split('\n', 1)[0]).toBe('feat: lorem ipsum subject line');
    // Subject is followed by a blank line then the body paragraph.
    expect(msg).toMatch(/subject line\n\nLorem ipsum/);
    // Paragraph break between body and bullet list survives as one blank line.
    expect(msg).toMatch(/aliqua\.\n\n- Ut enim/);
    // Two consecutive body lines stay joined by a single newline.
    expect(msg).toMatch(/Sed do\neiusmod tempor incididunt/);
    // The trailing blank before the next commit is trimmed.
    expect(msg.endsWith('\n')).toBe(false);

    expect(r[1]?.message).toBe('feat: short single-line subject');
  });
});
