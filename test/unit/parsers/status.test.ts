import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseStatus } from '../../../src/diversion/parsers/status';

const FIX = path.resolve(__dirname, '../../fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

describe('parseStatus', () => {
  it('parses a clean workspace', () => {
    const r = parseStatus(read('status-clean.txt'));
    expect(r.repoName).toBe('SampleRepo');
    expect(r.repoId).toBe('dv.repo.00000000-0000-0000-0000-000000000000');
    expect(r.branchName).toBe('main');
    expect(r.branchId).toBe('dv.branch.1');
    expect(r.commitId).toBe('dv.commit.40');
    expect(r.workspaceId).toBe('dv.ws.00000000-0000-0000-0000-000000000000');
    expect(r.workspaceLabel).toBe('sample-workspace @ sample-host');
    expect(r.totalChangedPaths).toBe(0);
    expect(r.totalChangedFiles).toBe(0);
    expect(r.changes).toEqual([]);
  });

  it('parses a workspace with one new path', () => {
    const r = parseStatus(read('status-modified-and-new.txt'));
    expect(r.totalChangedPaths).toBe(1);
    expect(r.totalChangedFiles).toBe(0);
    expect(r.changes).toEqual([
      { kind: 'added', path: 'Plugins/UnrealClaude' },
    ]);
  });

  it('parses Modified/Deleted/New sections together', () => {
    const r = parseStatus(read('status-mixed-synthetic.txt'));
    expect(r.totalChangedPaths).toBe(5);
    expect(r.totalChangedFiles).toBe(3);
    const byKind = r.changes.reduce<Record<string, string[]>>((acc, c) => {
      (acc[c.kind] ??= []).push(c.path);
      return acc;
    }, {});
    expect(byKind).toEqual({
      modified: [
        'Source/Survival/Private/Player.cpp',
        'Source/Survival/Public/Player.h',
      ],
      deleted: ['Source/Old/Removed.cpp'],
      added: ['Plugins/UnrealClaude', 'Source/New/Added.cpp'],
    });
  });

  it('returns sane defaults for empty input', () => {
    const r = parseStatus('');
    expect(r.repoName).toBe('');
    expect(r.changes).toEqual([]);
  });
});
