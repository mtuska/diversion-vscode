import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseUnifiedDiff } from '../../../src/diversion/parsers/unifiedDiff';
import { reverseApply } from '../../../src/diversion/reverseApply';

const FIX = path.resolve(__dirname, '../../fixtures');

/**
 * Regression test for a real `dv diff` output the user reported as failing
 * to render via QuickDiff. We capture both the diff and the actual working
 * file and verify reverseApply produces a base distinct from the working
 * (i.e. that we'd actually show a meaningful diff).
 */
describe('reverseApply against real dv overview.md fixture', () => {
  it('produces a base file content that differs from working', () => {
    const working = fs.readFileSync(path.join(FIX, 'dv-real-overview.working.md'), 'utf8');
    const diffText = fs.readFileSync(path.join(FIX, 'dv-real-overview.diff.txt'), 'utf8');
    const diff = parseUnifiedDiff(diffText);

    expect(diff.binary).toBe(false);
    expect(diff.hunks.length).toBeGreaterThan(0);

    const base = reverseApply(working, diff);
    expect(base, 'reverseApply returned undefined — context lines did not match').toBeDefined();
    expect(base).not.toBe(working);

    // Sanity: the base should contain the OLD SampleMesh line and not the
    // new one; the working should be the inverse.
    expect(working).toContain('TBD (likely Q4 2026 / Q1 2027)');
    expect(working).not.toContain('Working POC; same-shard handoff');
    expect(base).toContain('Working POC; same-shard handoff');
    expect(base).not.toContain('TBD (likely Q4 2026 / Q1 2027)');
  });
});
