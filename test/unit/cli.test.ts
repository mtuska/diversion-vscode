import { describe, expect, it } from 'vitest';
import { looksLikeError } from '../../src/diversion/cli';

describe('looksLikeError', () => {
  it('matches "not a diversion repository" message', () => {
    expect(looksLikeError(
      'Current directory is not a diversion repository (neither is any of its parent directories).\n',
    )).toBe(true);
  });

  it('matches "Error:" prefix', () => {
    expect(looksLikeError('Error: something went wrong\n')).toBe(true);
    expect(looksLikeError('error: lowercase variant\n')).toBe(true);
  });

  it('does not flag normal output', () => {
    expect(looksLikeError('In repo Foo dv.repo.123\n')).toBe(false);
    expect(looksLikeError('A\tpath/to/file\n')).toBe(false);
  });

  it('handles empty input', () => {
    expect(looksLikeError('')).toBe(false);
  });
});
