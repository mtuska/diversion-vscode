import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dropAncestorDirectories } from '../../src/diversion/repo';
import { parseDiffNameStatus } from '../../src/diversion/parsers/diffNameStatus';

const FIX = path.resolve(__dirname, '../fixtures');

describe('dropAncestorDirectories', () => {
  // Captured from dv.commit.509 in a real repo: `dv show --name-status` lists
  // the added folder AND its three files. The CoreAPI compare endpoint reports
  // ONLY the folder, which is what made the graph show one un-openable row.
  it('drops the folder row from a real folder-add commit', () => {
    const raw = fs.readFileSync(path.join(FIX, 'show-name-status-folder-add.txt'), 'utf8');
    const parsed = parseDiffNameStatus(raw);
    expect(parsed).toHaveLength(4); // folder + 3 files

    const files = dropAncestorDirectories(parsed);
    expect(files.map((c) => c.path)).toEqual([
      'Source/ProjectNod/Private/Tests/Navigation/NodStrategicGraphBenchmark.h',
      'Source/ProjectNod/Private/Tests/Navigation/NodStrategicGraphBenchmark.cpp',
      'Source/ProjectNod/Private/Tests/Navigation/NodStrategicGraphBenchmarkTests.cpp',
    ]);
    expect(files.every((c) => c.kind === 'added')).toBe(true);
  });

  it('leaves a list with no ancestors untouched', () => {
    const changes = [
      { kind: 'modified' as const, path: 'a/b.ts' },
      { kind: 'added' as const, path: 'c/d.ts' },
    ];
    expect(dropAncestorDirectories(changes)).toEqual(changes);
  });

  it('drops every level of a nested folder add', () => {
    const changes = [
      { kind: 'added' as const, path: 'Content' },
      { kind: 'added' as const, path: 'Content/Fish' },
      { kind: 'added' as const, path: 'Content/Fish/Textures' },
      { kind: 'added' as const, path: 'Content/Fish/Textures/a.uasset' },
    ];
    expect(dropAncestorDirectories(changes).map((c) => c.path))
      .toEqual(['Content/Fish/Textures/a.uasset']);
  });

  // An empty directory has no descendants, so it is the only thing the commit
  // actually did — keeping it is accurate, not noise.
  it('keeps a folder that has no files under it', () => {
    const changes = [
      { kind: 'added' as const, path: 'EmptyDir' },
      { kind: 'added' as const, path: 'Other/file.txt' },
    ];
    expect(dropAncestorDirectories(changes).map((c) => c.path))
      .toEqual(['EmptyDir', 'Other/file.txt']);
  });

  // A file named as a prefix of a *sibling* must survive: only a real path
  // separator makes something an ancestor.
  it('does not treat a shared name prefix as an ancestor', () => {
    const changes = [
      { kind: 'added' as const, path: 'src/foo' },
      { kind: 'added' as const, path: 'src/foobar/x.ts' },
    ];
    expect(dropAncestorDirectories(changes).map((c) => c.path))
      .toEqual(['src/foo', 'src/foobar/x.ts']);
  });
});
