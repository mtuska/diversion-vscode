import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverDvBinary, dvCandidatePaths } from '../../src/diversion/discoverDv';

describe('dvCandidatePaths', () => {
  it('always offers the installer location for the platform', () => {
    const home = os.homedir();
    expect(dvCandidatePaths('darwin')).toContain(path.join(home, '.diversion', 'bin', 'dv'));
    expect(dvCandidatePaths('linux')).toContain(path.join(home, '.diversion', 'bin', 'dv'));
    expect(dvCandidatePaths('win32')).toContain(path.join(home, '.diversion', 'bin', 'dv.exe'));
  });

  it('covers both Homebrew prefixes on macOS', () => {
    const mac = dvCandidatePaths('darwin');
    expect(mac).toContain('/opt/homebrew/bin/dv');
    expect(mac).toContain('/usr/local/bin/dv');
  });

  it('does not offer macOS app-bundle paths on linux', () => {
    expect(dvCandidatePaths('linux').some((p) => p.includes('.app/Contents'))).toBe(false);
  });

  it('uses the .exe suffix only on windows', () => {
    expect(dvCandidatePaths('win32').every((p) => p.endsWith('.exe'))).toBe(true);
    expect(dvCandidatePaths('linux').some((p) => p.endsWith('.exe'))).toBe(false);
  });

  // A repo must never be able to steer us at a binary it ships; every
  // candidate is an absolute system path.
  it('yields only absolute paths', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const p of dvCandidatePaths(platform)) {
        expect(path.isAbsolute(p)).toBe(true);
      }
    }
  });

  it('contains no duplicates', () => {
    const linux = dvCandidatePaths('linux');
    expect(new Set(linux).size).toBe(linux.length);
  });
});

describe('discoverDvBinary', () => {
  it('returns undefined when nothing matches', async () => {
    expect(await discoverDvBinary(['/definitely/not/here/dv'])).toBeUndefined();
  });

  it('skips directories and non-executable files, then finds the real one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-discover-'));
    try {
      const asDir = path.join(dir, 'adir');
      fs.mkdirSync(asDir);
      const notExec = path.join(dir, 'plain');
      fs.writeFileSync(notExec, '', { mode: 0o644 });
      const exec = path.join(dir, 'dv');
      fs.writeFileSync(exec, '', { mode: 0o755 });

      expect(await discoverDvBinary([asDir, notExec, exec])).toBe(exec);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the first match, honouring candidate priority', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-discover-'));
    try {
      const first = path.join(dir, 'first');
      const second = path.join(dir, 'second');
      fs.writeFileSync(first, '', { mode: 0o755 });
      fs.writeFileSync(second, '', { mode: 0o755 });
      expect(await discoverDvBinary([first, second])).toBe(first);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
