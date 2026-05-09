import { describe, expect, it } from 'vitest';
import { parseSidecarPath } from '../../src/diversion/conflictPaths';

describe('parseSidecarPath', () => {
  it('parses standard suffix form', () => {
    const r = parseSidecarPath('/repo/Foo/bar.dv-conflict.txt');
    expect(r).toEqual({
      sidecarPath: '/repo/Foo/bar.dv-conflict.txt',
      originalPath: '/repo/Foo/bar.txt',
      index: 0,
    });
  });

  it('parses numbered suffix form', () => {
    const r = parseSidecarPath('/repo/Foo/bar.dv-conflict-3.txt');
    expect(r).toEqual({
      sidecarPath: '/repo/Foo/bar.dv-conflict-3.txt',
      originalPath: '/repo/Foo/bar.txt',
      index: 3,
    });
  });

  it('parses no-extension form', () => {
    const r = parseSidecarPath('/repo/Foo/baz.dv-conflict');
    expect(r).toEqual({
      sidecarPath: '/repo/Foo/baz.dv-conflict',
      originalPath: '/repo/Foo/baz',
      index: 0,
    });
  });

  it('parses no-extension numbered form', () => {
    const r = parseSidecarPath('/repo/Foo/baz.dv-conflict-2');
    expect(r).toEqual({
      sidecarPath: '/repo/Foo/baz.dv-conflict-2',
      originalPath: '/repo/Foo/baz',
      index: 2,
    });
  });

  it('parses Unreal asset form', () => {
    const r = parseSidecarPath('/repo/Content/Hero.dv-conflict.uasset');
    expect(r).toEqual({
      sidecarPath: '/repo/Content/Hero.dv-conflict.uasset',
      originalPath: '/repo/Content/Hero.uasset',
      index: 0,
    });
  });

  it('returns undefined for non-conflict paths', () => {
    expect(parseSidecarPath('/repo/Foo/bar.txt')).toBeUndefined();
    expect(parseSidecarPath('/repo/Foo/bar.dvconflict.txt')).toBeUndefined();
    expect(parseSidecarPath('/repo/notes-dv-conflict.txt')).toBeUndefined();
  });
});
