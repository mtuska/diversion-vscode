import { describe, expect, it } from 'vitest';
import { summarizeDvError } from '../../src/diversion/cli';

describe('summarizeDvError', () => {
  it('extracts status + detail from the dv 403 envelope', () => {
    const raw = `Failed to lock file: Oh no, looks like something went wrong!

An engineer has been notified - we're on it. Your files are safe and you can continue working normally.

Please run \`dv support\` if the issue persists.
[failed to execute PUT '/repos/{repo_id}/locks/{path}' (SrcHandlersv2FileLocksLockFile) [abc-123]: decode response: request failed: {"status":403,"detail":"Hard locks require a Studio or Enterprise subscription"}
: unexpected status code: 403]
`;
    expect(summarizeDvError(raw)).toBe('(403) Hard locks require a Studio or Enterprise subscription');
  });

  it('falls back to the first non-apology line when there is no detail', () => {
    const raw = `Failed to commit: nothing to commit\n`;
    expect(summarizeDvError(raw)).toBe('Failed to commit: nothing to commit');
  });

  it('skips apology lines and the [failed to execute …] line', () => {
    const raw = `Oh no, looks like something went wrong!\n\nNetwork unreachable\n[failed to execute GET '/x']\n`;
    expect(summarizeDvError(raw)).toBe('Network unreachable');
  });

  it('returns empty for empty input', () => {
    expect(summarizeDvError('')).toBe('');
  });

  it('detail without status', () => {
    expect(summarizeDvError('foo {"detail":"oops"} bar')).toBe('oops');
  });
});
