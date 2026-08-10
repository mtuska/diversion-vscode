import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeRepoPath, safeRepoPattern, safeRef } from '../../src/diversion/argGuard';

const ROOT = path.sep === '\\' ? 'C:\\repo' : '/repo';

describe('safeRepoPath', () => {
  it('passes an ordinary repo-relative path through unchanged', () => {
    expect(safeRepoPath(ROOT, 'src/foo.ts')).toBe('src/foo.ts');
    expect(safeRepoPath(ROOT, 'a/b/c.bin')).toBe('a/b/c.bin');
  });

  it('allows internal ".." that stays inside the root', () => {
    expect(safeRepoPath(ROOT, 'a/../b')).toBe('a/../b');
  });

  it('rejects a traversal path that escapes the root', () => {
    expect(() => safeRepoPath(ROOT, '../../etc/passwd')).toThrow(/escapes the repository root/);
    expect(() => safeRepoPath(ROOT, 'a/../../../etc/passwd')).toThrow(/escapes the repository root/);
  });

  it('rejects an absolute path outside the root', () => {
    const outside = path.sep === '\\' ? 'C:\\other\\x' : '/etc/passwd';
    expect(() => safeRepoPath(ROOT, outside)).toThrow(/escapes the repository root/);
  });

  it('rejects an empty operand', () => {
    expect(() => safeRepoPath(ROOT, '   ')).toThrow(/Empty path operand/);
  });

  it('neutralizes a flag-like path by prefixing ./', () => {
    expect(safeRepoPath(ROOT, '--clean')).toBe('./--clean');
    expect(safeRepoPath(ROOT, '-rf')).toBe('./-rf');
  });
});

describe('safeRef', () => {
  it('passes ordinary refs through', () => {
    expect(safeRef('main')).toBe('main');
    expect(safeRef('dv.commit.123', 'commit')).toBe('dv.commit.123');
    expect(safeRef('feature/my-branch', 'branch')).toBe('feature/my-branch');
  });

  it('rejects a flag-like ref', () => {
    expect(() => safeRef('--help')).toThrow(/looks like a flag/);
    expect(() => safeRef('-d', 'branch')).toThrow(/looks like a flag/);
  });

  it('rejects an empty ref with the kind in the message', () => {
    expect(() => safeRef('  ', 'shelf')).toThrow(/Empty shelf operand/);
  });
});

describe('safeRepoPattern', () => {
  it('preserves glob metacharacters — patterns are not filesystem paths', () => {
    expect(safeRepoPattern('/Assets/*.psd')).toBe('/Assets/*.psd');
    expect(safeRepoPattern('/Content/**/?.uasset')).toBe('/Content/**/?.uasset');
  });

  it('trims surrounding whitespace', () => {
    expect(safeRepoPattern('  /Binaries/*  ')).toBe('/Binaries/*');
  });

  // `./`-prefixing (what safeRepoPath does) would change what a root-anchored
  // glob matches, so a flag-looking pattern is rejected rather than rewritten.
  it('rejects a pattern that would parse as a flag', () => {
    expect(() => safeRepoPattern('--keep')).toThrow(/looks like a flag/);
    expect(() => safeRepoPattern('-x')).toThrow(/looks like a flag/);
  });

  it('rejects an empty pattern', () => {
    expect(() => safeRepoPattern('   ')).toThrow(/Empty pattern/);
  });
});
