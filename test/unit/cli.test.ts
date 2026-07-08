import { describe, expect, it } from 'vitest';
import { looksLikeError, resolveDvPath, runDv } from '../../src/diversion/cli';

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

describe('resolveDvPath', () => {
  const platformDefault = process.platform === 'win32' ? 'dv.exe' : 'dv';

  it('defaults to the platform command name when unset or empty', () => {
    expect(resolveDvPath(undefined)).toBe(platformDefault);
    expect(resolveDvPath('')).toBe(platformDefault);
    expect(resolveDvPath('   ')).toBe(platformDefault);
  });

  it('allows a bare command name (PATH lookup)', () => {
    expect(resolveDvPath('dv')).toBe('dv');
    expect(resolveDvPath('mydv')).toBe('mydv');
  });

  it('allows an absolute path', () => {
    const abs = process.platform === 'win32' ? 'C:\\tools\\dv.exe' : '/usr/local/bin/dv';
    expect(resolveDvPath(abs)).toBe(abs);
  });

  it('rejects a relative path with a separator (repo-relative execution vector)', () => {
    expect(() => resolveDvPath('./tools/dv')).toThrow(/relative path/);
    expect(() => resolveDvPath('tools/dv')).toThrow(/relative path/);
    expect(() => resolveDvPath('../dv')).toThrow(/relative path/);
  });
});

// Uses `node` as a stand-in for the `dv` binary to exercise the runner's
// process handling (output cap, normal completion) without a real dv install.
describe('runDv output cap', () => {
  const nodeOpts = { cwd: process.cwd(), dvPath: 'node' as string };

  it('returns output that stays under the cap', async () => {
    const r = await runDv(['-e', 'process.stdout.write("hello")'], { ...nodeOpts, maxBytes: 1000 });
    expect(r.stdout).toBe('hello');
    expect(r.exitCode).toBe(0);
  });

  it('rejects when combined output exceeds maxBytes', async () => {
    await expect(
      runDv(['-e', 'process.stdout.write("x".repeat(5000))'], { ...nodeOpts, maxBytes: 100 }),
    ).rejects.toThrow(/more than 100 bytes/);
  });
});
