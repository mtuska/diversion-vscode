import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreApiClient, CoreApiError, sanitizeBaseUrl } from '../../src/diversion/coreApi.js';

const REPO = 'dv.repo.abc';
const WS = 'dv.ws.xyz';

const logger = { error() {}, warn() {}, info() {}, debug() {} };

/** Minimal daemon stub: hands out a far-future token and one local clone. */
function fakeDaemon(overrides: Partial<{ tokenCalls: { n: number } }> = {}) {
  const tokenCalls = overrides.tokenCalls ?? { n: 0 };
  return {
    tokenCalls,
    async coreToken() {
      tokenCalls.n++;
      return { AccessToken: 'tok', ExpiresAt: Math.floor(Date.now() / 1000) + 3600 };
    },
    async workspaces() {
      return { [WS]: { RepoID: REPO, Path: '/tmp/ws' } };
    },
  } as never;
}

/** Stub global fetch with a URL-substring → JSON body table. */
function stubFetch(routes: Array<[string, unknown]>) {
  const fn = vi.fn(async (url: string) => {
    const match = routes.find(([frag]) => url.includes(frag));
    if (!match) return { ok: false, status: 404, async text() { return 'no route'; }, async json() { return {}; } };
    return { ok: true, status: 200, async text() { return ''; }, async json() { return match[1]; } };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** A minimal ok Response with a JSON body. */
function okJson(body: unknown) {
  return { ok: true, status: 200, async json() { return body; }, async text() { return ''; } };
}

afterEach(() => vi.unstubAllGlobals());

describe('sanitizeBaseUrl', () => {
  const PROD = 'https://api.diversion.dev/v0';

  it('uses production when unset and strips trailing slashes', () => {
    expect(sanitizeBaseUrl(undefined, logger)).toBe(PROD);
    expect(sanitizeBaseUrl('https://api.diversion.dev/v0//', logger)).toBe(PROD);
  });

  it('allows an https override (e.g. an internal mirror)', () => {
    expect(sanitizeBaseUrl('https://mirror.internal/v0', logger)).toBe('https://mirror.internal/v0');
  });

  it('allows http only for loopback (local test daemons)', () => {
    expect(sanitizeBaseUrl('http://127.0.0.1:8080/v0', logger)).toBe('http://127.0.0.1:8080/v0');
    expect(sanitizeBaseUrl('http://localhost:8080/v0', logger)).toBe('http://localhost:8080/v0');
  });

  it('refuses a cleartext remote endpoint and falls back to production', () => {
    const warn = vi.fn();
    expect(sanitizeBaseUrl('http://evil.example/v0', { ...logger, warn })).toBe(PROD);
    expect(warn).toHaveBeenCalled();
  });

  it('refuses a non-http(s) scheme and falls back to production', () => {
    expect(sanitizeBaseUrl('file:///etc/passwd', logger)).toBe(PROD);
    expect(sanitizeBaseUrl('ftp://evil.example/v0', logger)).toBe(PROD);
  });

  it('falls back to production on an unparseable value', () => {
    expect(sanitizeBaseUrl('not a url', logger)).toBe(PROD);
  });
});

describe('CoreApiClient.listBranches', () => {
  it('maps fields and drops deleted branches', async () => {
    stubFetch([['/branches', {
      object: 'Branch',
      items: [
        { branch_id: 'dv.branch.1', branch_name: 'main', commit_id: 'dv.commit.46', is_deleted: false },
        { branch_id: 'dv.branch.9', branch_name: 'gone', commit_id: 'dv.commit.10', is_deleted: true },
      ],
    }]]);
    const client = new CoreApiClient(fakeDaemon(), logger);
    expect(await client.listBranches(REPO)).toEqual([
      { name: 'main', id: 'dv.branch.1', commitId: 'dv.commit.46' },
    ]);
  });
});

describe('CoreApiClient.listCommits / logOneline', () => {
  it('maps commit details and derives a one-line subject', async () => {
    stubFetch([['/commits', {
      object: 'Commit',
      items: [{
        commit_id: 'dv.commit.46',
        commit_message: 'Update ue-mcp\n\nbody line',
        created_ts: 1780075070,
        branch_id: 'dv.branch.1',
        author: { full_name: 'Montana Tuska', email: 'm@frs.llc', name: 'dv.u.x' },
        parents: ['dv.commit.45'],
        parent_branches: [{ id: 'dv.branch.1', name: 'main' }],
      }],
    }]]);
    const client = new CoreApiClient(fakeDaemon(), logger);
    const [c] = await client.listCommits(REPO, { limit: 1 });
    expect(c.id).toBe('dv.commit.46');
    expect(c.authorName).toBe('Montana Tuska');
    expect(c.refs).toEqual(['main']);
    expect(c.date).toBe(new Date(1780075070 * 1000).toISOString());
    const [summary] = await client.logOneline(REPO, 1);
    expect(summary).toEqual({ id: 'dv.commit.46', subject: 'Update ue-mcp' });
  });

  it('flags merge commits from multiple parents', async () => {
    stubFetch([['/commits', {
      items: [{
        commit_id: 'dv.commit.38', commit_message: 'merge', created_ts: 1,
        parents: ['dv.commit.37', 'dv.commit.36'],
        parent_branches: [{ id: 'dv.branch.1', name: 'main' }, { id: 'dv.branch.5', name: 'feat' }],
      }],
    }]]);
    const client = new CoreApiClient(fakeDaemon(), logger);
    const [c] = await client.listCommits(REPO, { limit: 1 });
    expect(c.merge).toEqual({ refName: 'feat', commitId: 'dv.commit.36' });
  });
});

describe('CoreApiClient.commitChanges (compare)', () => {
  it('derives change kinds from base/other item presence', async () => {
    stubFetch([
      ['/commits', { items: [{ commit_id: 'dv.commit.46', commit_message: 'x', created_ts: 1, parents: ['dv.commit.45'] }] }],
      ['/compare', {
        object: 'ComparisonItem',
        items: [
          { base_item: null, other_item: { path: 'added.txt', prev_path: null, hash: 'h', prev_hash: null, status: 2 } },
          { base_item: { path: 'gone.txt', prev_path: null, hash: 'h', prev_hash: null, status: 4 }, other_item: null },
          { base_item: { path: 'm.txt', prev_path: null, hash: 'p', prev_hash: null, status: 3 }, other_item: { path: 'm.txt', prev_path: 'm.txt', hash: 'h', prev_hash: 'p', status: 3 } },
          { base_item: { path: 'old.txt', prev_path: null, hash: 'p', prev_hash: null, status: 3 }, other_item: { path: 'renamed.txt', prev_path: 'old.txt', hash: 'h', prev_hash: 'p', status: 3 } },
        ],
      }],
    ]);
    const client = new CoreApiClient(fakeDaemon(), logger);
    expect(await client.commitChanges(REPO, 'dv.commit.46')).toEqual([
      { kind: 'added', path: 'added.txt' },
      { kind: 'deleted', path: 'gone.txt' },
      { kind: 'modified', path: 'm.txt' },
      { kind: 'renamed', path: 'renamed.txt', fromPath: 'old.txt' },
    ]);
  });
});

describe('CoreApiClient immutable-read caching', () => {
  it('caches commitChanges by commit ID (single fetch pair on repeat)', async () => {
    const fn = stubFetch([
      ['/commits', { items: [{ commit_id: 'dv.commit.46', commit_message: 'x', created_ts: 1, parents: ['dv.commit.45'] }] }],
      ['/compare', { object: 'ComparisonItem', items: [] }],
    ]);
    const client = new CoreApiClient(fakeDaemon(), logger);
    await client.commitChanges(REPO, 'dv.commit.46');
    const callsAfterFirst = fn.mock.calls.length; // one /commits + one /compare
    await client.commitChanges(REPO, 'dv.commit.46');
    expect(fn.mock.calls.length).toBe(callsAfterFirst); // fully served from cache
    expect(callsAfterFirst).toBe(2);
  });

  it('coalesces concurrent identical commit fetches into one request', async () => {
    const fn = stubFetch([
      ['/commits', { items: [{ commit_id: 'dv.commit.7', commit_message: 'x', created_ts: 1, parents: [] }] }],
    ]);
    const client = new CoreApiClient(fakeDaemon(), logger);
    await Promise.all([
      client.getCommit(REPO, 'dv.commit.7'),
      client.getCommit(REPO, 'dv.commit.7'),
      client.getCommit(REPO, 'dv.commit.7'),
    ]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not cache a compare whose base is a mutable branch ref', async () => {
    const fn = stubFetch([['/compare', { object: 'ComparisonItem', items: [] }]]);
    const client = new CoreApiClient(fakeDaemon(), logger);
    await client.compare(REPO, 'dv.branch.1', 'dv.commit.2');
    await client.compare(REPO, 'dv.branch.1', 'dv.commit.2');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('CoreApiClient token single-flight', () => {
  it('mints one token for concurrent cold-start requests', async () => {
    stubFetch([['/branches', { object: 'Branch', items: [] }]]);
    const tokenCalls = { n: 0 };
    const client = new CoreApiClient(fakeDaemon({ tokenCalls }), logger);
    await Promise.all([
      client.listBranches(REPO),
      client.listBranches(REPO),
      client.listBranches(REPO),
    ]);
    expect(tokenCalls.n).toBe(1);
  });
});

describe('CoreApiClient.listShelves', () => {
  it('formats a description from timestamp + branch', async () => {
    stubFetch([['/shelves', {
      object: 'Shelf',
      items: [{ id: 'dv.shelf.1', name: 'wip', created_timestamp: 1780075070, branch_id: 'dv.branch.1' }],
    }]]);
    const client = new CoreApiClient(fakeDaemon(), logger);
    const [s] = await client.listShelves(REPO);
    expect(s.id).toBe('dv.shelf.1');
    expect(s.name).toBe('wip');
    expect(s.description).toContain('dv.branch.1');
  });
});

describe('CoreApiClient.listOpenMerges', () => {
  it('maps merge refs and the initiating user', async () => {
    stubFetch([['/merges', {
      object: 'Merge',
      items: [{
        id: 'dv.merge.1',
        repo_id: REPO,
        base_ref: 'dv.branch.1',
        other_ref: 'dv.branch.7',
        ancestor_commit: 'dv.commit.100',
        user: { id: 'dv.u.1', full_name: 'Ada Lovelace', name: 'ada' },
      }],
    }]]);
    const client = new CoreApiClient(fakeDaemon(), logger);
    expect(await client.listOpenMerges(REPO)).toEqual([
      { id: 'dv.merge.1', baseRef: 'dv.branch.1', otherRef: 'dv.branch.7', startedBy: 'Ada Lovelace' },
    ]);
  });

  it('omits startedBy when the API supplies no name, and handles an empty list', async () => {
    stubFetch([['/merges', {
      object: 'Merge',
      items: [{ id: 'dv.merge.2', repo_id: REPO, base_ref: 'main', other_ref: 'feature', user: { id: 'dv.u.1' } }],
    }]]);
    const client = new CoreApiClient(fakeDaemon(), logger);
    expect(await client.listOpenMerges(REPO)).toEqual([
      { id: 'dv.merge.2', baseRef: 'main', otherRef: 'feature' },
    ]);

    stubFetch([['/merges', { object: 'Merge' }]]);
    expect(await new CoreApiClient(fakeDaemon(), logger).listOpenMerges(REPO)).toEqual([]);
  });
});

describe('CoreApiClient merge conflict resolution', () => {
  const DETAILED = {
    id: 'dv.merge.1',
    repo_id: REPO,
    base_ref: 'dv.branch.1',
    other_ref: 'dv.branch.7',
    ancestor_commit: 'dv.commit.100',
    conflicts: [
      {
        conflict_id: 'c1',
        is_resolved: false,
        base: { conflict_index_id: 'BASE', file_mode: 33188, path: 'src/a.ts', type: 3 },
        other: { conflict_index_id: 'OTHER', file_mode: 33188, path: 'src/a.ts', type: 3 },
      },
      {
        conflict_id: 'c2',
        is_resolved: true,
        resolved_side: 'OTHER',
        base: { conflict_index_id: 'BASE', file_mode: 33188, path: 'src/b.ts', type: 3 },
        other: { conflict_index_id: 'OTHER', file_mode: 33261, path: 'src/b.ts', type: 3 },
      },
    ],
  };

  it('maps conflicts and carries the file mode needed to submit', async () => {
    stubFetch([['/merges/dv.merge.1', DETAILED]]);
    const merge = await new CoreApiClient(fakeDaemon(), logger).getMerge(REPO, 'dv.merge.1');
    expect(merge.conflicts).toHaveLength(2);
    expect(merge.conflicts[0]).toEqual({
      id: 'c1', resolved: false, path: 'src/a.ts',
      basePath: 'src/a.ts', otherPath: 'src/a.ts', fileMode: 33188,
    });
    expect(merge.conflicts[1]!.resolved).toBe(true);
    expect(merge.conflicts[1]!.resolvedSide).toBe('OTHER');
    // The incoming side's mode wins — that's what a "keep incoming" carries.
    expect(merge.conflicts[1]!.fileMode).toBe(33261);
  });

  it('posts the resolved bytes with mode and size', async () => {
    const fn = vi.fn(async () => ({ ok: true, status: 202, async text() { return ''; }, async json() { return {}; } }));
    vi.stubGlobal('fetch', fn);
    await new CoreApiClient(fakeDaemon(), logger)
      .setConflictResult(REPO, 'dv.merge.1', 'c1', 'merged\n', 33188);
    const [url, init] = fn.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    expect(String(url)).toContain('/merges/dv.merge.1/conflicts/c1');
    expect(String(url)).toContain('mode=33188');
    expect(String(url)).toContain('size=7');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
  });

  it('finalizes with a commit message', async () => {
    const fn = vi.fn(async () => ({ ok: true, status: 200, async text() { return ''; }, async json() { return {}; } }));
    vi.stubGlobal('fetch', fn);
    await new CoreApiClient(fakeDaemon(), logger).finalizeMerge(REPO, 'dv.merge.1', 'Merge it');
    const [, init] = fn.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ commit_message: 'Merge it' }));
  });

  it('reads an inline blob', async () => {
    const fn = vi.fn(async () => ({
      ok: true, status: 200, headers: new Headers(),
      async text() { return 'file contents'; },
    }));
    vi.stubGlobal('fetch', fn);
    const text = await new CoreApiClient(fakeDaemon(), logger).blobText(REPO, 'dv.branch.1', 'src/a.ts');
    expect(text).toBe('file contents');
  });

  // The bearer is write-capable. Following a 204 redirect to presigned object
  // storage must not carry it to a non-Diversion host.
  it('follows a 204 blob redirect without forwarding the bearer', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce({
        ok: false, status: 204,
        headers: new Headers({ location: 'https://s3.example.com/blob?sig=abc' }),
        async text() { return ''; },
      })
      .mockResolvedValueOnce({ ok: true, status: 200, async text() { return 'from storage'; } });
    vi.stubGlobal('fetch', fn);
    const text = await new CoreApiClient(fakeDaemon(), logger).blobText(REPO, 'dv.branch.1', 'a.bin');
    expect(text).toBe('from storage');
    const [, init] = fn.mock.calls[1]! as unknown as [string, { headers: Record<string, string> }];
    expect(JSON.stringify(init.headers)).not.toContain('tok');
    expect(init.headers).not.toHaveProperty('Authorization');
  });
});

describe('CoreApiClient.listRepos', () => {
  it('marks repos cloned locally using the agent registry', async () => {
    stubFetch([['/repos', {
      object: 'Repo',
      items: [
        { repo_id: REPO, repo_name: 'Prototypes' },
        { repo_id: 'dv.repo.other', repo_name: 'Remote' },
      ],
    }]]);
    const client = new CoreApiClient(fakeDaemon(), logger);
    expect(await client.listRepos()).toEqual([
      { name: 'Prototypes', id: REPO, cloned: true, localPath: '/tmp/ws' },
      { name: 'Remote', id: 'dv.repo.other', cloned: false },
    ]);
  });
});

describe('CoreApiClient pagination', () => {
  it('pages branches with limit/skip until a short page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      branch_id: `dv.branch.${i}`, branch_name: `b${i}`, commit_id: 'c', is_deleted: false,
    }));
    const page2 = [{ branch_id: 'dv.branch.last', branch_name: 'last', commit_id: 'c', is_deleted: false }];
    const fn = vi.fn()
      .mockResolvedValueOnce(okJson({ items: page1 }))
      .mockResolvedValueOnce(okJson({ items: page2 }));
    vi.stubGlobal('fetch', fn);
    const branches = await new CoreApiClient(fakeDaemon(), logger).listBranches(REPO);
    expect(branches).toHaveLength(101);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(String(fn.mock.calls[0]![0])).toContain('skip=0');
    expect(String(fn.mock.calls[1]![0])).toContain('skip=100');
  });

  it('pages file history instead of truncating at one page', async () => {
    const commit = (n: number) => ({ commit_id: `dv.commit.${n}`, commit_message: `m${n}`, created_ts: 1780075070 });
    const fn = vi.fn()
      .mockResolvedValueOnce(okJson({ items: Array.from({ length: 100 }, (_, i) => commit(i)) }))
      .mockResolvedValueOnce(okJson({ items: Array.from({ length: 50 }, (_, i) => commit(100 + i)) }));
    vi.stubGlobal('fetch', fn);
    const history = await new CoreApiClient(fakeDaemon(), logger)
      .fileHistory(REPO, 'dv.commit.900', 'src/deep/file.ts', 150);
    expect(history).toHaveLength(150);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(String(fn.mock.calls[0]![0])).toContain('limit=100&skip=0');
    expect(String(fn.mock.calls[1]![0])).toContain('limit=50&skip=100');
  });

  it('stops file-history paging on a short page and keeps path separators', async () => {
    const fn = vi.fn().mockResolvedValueOnce(okJson({
      items: [{ commit_id: 'dv.commit.1', commit_message: 'only', created_ts: 1780075070 }],
    }));
    vi.stubGlobal('fetch', fn);
    const history = await new CoreApiClient(fakeDaemon(), logger)
      .fileHistory(REPO, 'dv.commit.900', 'src/a b/file.ts', 150);
    expect(history).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(String(fn.mock.calls[0]![0])).toContain('/files/history/dv.commit.900/src/a%20b/file.ts');
  });
});

describe('CoreApiClient retry policy', () => {
  it('retries once on a transient network error, then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(okJson({ items: [] }));
    vi.stubGlobal('fetch', fn);
    await new CoreApiClient(fakeDaemon(), logger).listBranches(REPO);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry an HTTP error response', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: false, status: 500, async text() { return 'boom'; }, async json() { return {}; } });
    vi.stubGlobal('fetch', fn);
    await expect(new CoreApiClient(fakeDaemon(), logger).listBranches(REPO)).rejects.toBeInstanceOf(CoreApiError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a timeout (AbortError)', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    vi.stubGlobal('fetch', fn);
    await expect(new CoreApiClient(fakeDaemon(), logger).listBranches(REPO)).rejects.toBeInstanceOf(CoreApiError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('CoreApiClient request headers', () => {
  it('sends app-name, app-version, and a correlation id', async () => {
    const fn = vi.fn().mockResolvedValue(okJson({ items: [] }));
    vi.stubGlobal('fetch', fn);
    await new CoreApiClient(fakeDaemon(), logger).listBranches(REPO);
    const headers = (fn.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers['X-DV-App-Name']).toBe('@mtuska/vscode-diversion');
    expect(headers['X-DV-App-Version']).toBeTruthy();
    expect(headers['X-Sentry-Correlation-ID']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe('CoreApiClient token caching', () => {
  it('mints the bearer once and reuses it across calls', async () => {
    stubFetch([['/branches', { items: [] }]]);
    const daemon = fakeDaemon();
    const client = new CoreApiClient(daemon, logger);
    await client.listBranches(REPO);
    await client.listBranches(REPO);
    expect((daemon as unknown as { tokenCalls: { n: number } }).tokenCalls.n).toBe(1);
  });
});
