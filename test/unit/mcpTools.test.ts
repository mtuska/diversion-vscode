import { describe, expect, it } from 'vitest';
import { registerAllTools } from '../../src/mcp/tools';

/** Records the tool names registered, ignoring config + handler. */
function fakeServer() {
  const names: string[] = [];
  return {
    names,
    registerTool(name: string) { names.push(name); },
  };
}

// The registry is only touched inside tool handlers (via safe()), never at
// registration time, so a bare stub is enough to exercise registration.
const registry = {} as never;

describe('registerAllTools read-only gating', () => {
  it('registers the full surface by default', () => {
    const s = fakeServer();
    registerAllTools(s as never, registry);
    expect(s.names).toContain('dv_status');
    expect(s.names).toContain('dv_commit');
    expect(s.names).toContain('dv_discard_all');
  });

  it('omits every write tool in read-only mode', () => {
    const full = fakeServer();
    registerAllTools(full as never, registry);
    const ro = fakeServer();
    registerAllTools(ro as never, registry, { readOnly: true });

    expect(ro.names.length).toBeLessThan(full.names.length);
    // Read tools still present…
    expect(ro.names).toContain('dv_status');
    expect(ro.names).toContain('dv_log');
    // …and the mutating ones gone.
    for (const w of ['dv_commit', 'dv_discard_all', 'dv_discard_path', 'dv_delete_branch', 'dv_merge']) {
      expect(ro.names).not.toContain(w);
    }
  });
});
