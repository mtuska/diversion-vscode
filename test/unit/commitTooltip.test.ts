import { describe, expect, it } from 'vitest';
import { formatCommitTooltip } from '../../src/diversion/commitTooltip';

/** What the card actually renders: markdown escapes are display-invisible. */
const rendered = (md: string): string => md.replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1');

const base = {
  id: 'dv.commit.509',
  refs: [],
  authorName: 'Montana Tuska',
  authorEmail: 'mtuska@frs.llc',
  date: '2026-08-23T04:37:47Z',
  message: 'NOD-974 benchmark strategic graph hierarchy',
};

describe('formatCommitTooltip', () => {
  it('puts the identifying details under a rule, below the message', () => {
    const md = formatCommitTooltip(base);
    const [body, details] = md.split('\n\n---\n\n');
    expect(rendered(body!)).toContain('NOD-974 benchmark strategic graph hierarchy');
    expect(details).toContain('`dv.commit.509`');
    expect(rendered(details!)).toContain('Montana Tuska <mtuska@frs.llc>');
    expect(details).toMatch(/2026/);
  });

  it('keeps a multi-line body from collapsing into one paragraph', () => {
    const md = formatCommitTooltip({ ...base, message: 'subject\n\nbody line one\nbody line two' });
    expect(rendered(md)).toContain('body line one  \n');
  });

  // A commit message is arbitrary text; markdown in it must not restyle the card.
  it('escapes markdown in the message', () => {
    const md = formatCommitTooltip({ ...base, message: '# heading *bold* [link](x)' });
    expect(md).not.toMatch(/^# heading/m);
    expect(md).toContain('\\#');
    expect(md).toContain('\\*');
  });

  it('handles a missing author and an unparseable date', () => {
    const md = formatCommitTooltip({ ...base, authorName: '', authorEmail: '', date: 'nonsense' });
    expect(md).toContain('unknown');
    expect(md).not.toContain('<>');
  });

  it('still renders details when the message is empty', () => {
    const md = formatCommitTooltip({ ...base, message: '   ' });
    expect(md).toContain('`dv.commit.509`');
    expect(md.startsWith('\n')).toBe(false);
  });
});
