import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseBranchList } from '../../../src/diversion/parsers/branch';

const FIX = path.resolve(__dirname, '../../fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

describe('parseBranchList', () => {
  it('parses a 3-branch list', () => {
    const r = parseBranchList(read('branch-list.txt'));
    expect(r).toEqual([
      { name: 'main',       id: 'dv.branch.1', commitId: 'dv.commit.40' },
      { name: 'ai-tuska',   id: 'dv.branch.5', commitId: 'dv.commit.36' },
      { name: 'WebUiMaybe', id: 'dv.branch.9', commitId: 'dv.commit.34' },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseBranchList('')).toEqual([]);
  });
});
