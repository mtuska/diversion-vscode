import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { runDv } from '../diversion/cli.js';
import { parseUnifiedDiff, splitMultiFileDiff } from '../diversion/parsers/unifiedDiff.js';
import { reverseApply } from '../diversion/reverseApply.js';
import { looksBinary } from '../util/binary.js';
import { toForwardSlashes } from '../util/path.js';
import type { Logger } from '../util/log.js';

/** URI scheme used for "the contents of <file> at commit <id>". */
export const DV_COMMIT_SCHEME = 'dv-commit';

/** Cap for the on-disk cache directory. Older entries are evicted by mtime. */
const DISK_CACHE_BYTE_LIMIT = 50 * 1024 * 1024;

/**
 * When prefetching a commit with more files than this, we split the work
 * into N chunks and run them concurrently. Below the threshold, a single
 * `dv diff` call is cheaper than the per-process spawn cost of chunking.
 */
const PREFETCH_CHUNK_SIZE = 50;

function chunkArray<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface RepoLookup {
  rootForPath(fsPath: string): { root: string; dvPath: string | undefined } | undefined;
}

/**
 * Build a `dv-commit:` URI for the given absolute filesystem path at a
 * specific commit. The scheme + query encoding is:
 *
 *     dv-commit:<absPath>?commit=<commitId>
 *
 * The path part keeps the original fsPath so VS Code's diff editor uses a
 * sensible filename in the tab; the commit ID rides in the query string.
 */
export function commitContentUri(absFsPath: string, commitId: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: DV_COMMIT_SCHEME,
    path: absFsPath,
    query: `commit=${encodeURIComponent(commitId)}`,
  });
}

/**
 * Resolves `dv-commit:<absPath>?commit=<id>` URIs to the file contents at
 * the named commit. Strategy: read the working-tree contents, ask dv for
 * the unified diff between the requested commit and the workspace, then
 * reverse-apply to recover the at-commit version.
 *
 * Three caches:
 *   1. **In-memory promise cache** keyed by URI string — coalesces concurrent
 *      requests for the same content.
 *   2. **In-memory string cache** with the resolved content. Bounded only by
 *      session length.
 *   3. **On-disk cache** under `globalStorageUri/cache/<dvVersion>/` keyed by
 *      `repoId:commitId:relPath`. Commits are immutable, so cache entries
 *      never need to be rebuilt across sessions for the same dv version.
 *      Eviction is mtime-based when the directory exceeds 50MB.
 *
 * Empty string is returned (rather than `undefined`) for any failure mode
 * so the diff editor renders an empty side instead of throwing
 * "Invalid arguments".
 */
export class CommitContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private readonly memCache = new Map<string, Promise<string>>();
  private cacheDir: string | undefined;
  /** Set once we know dv's version (from the daemon health check). */
  private dvVersionSegment: string | undefined;

  constructor(
    private readonly lookup: RepoLookup,
    private readonly logger: Logger,
  ) {}

  /** Wire in the global storage URI + the running dv version. Optional. */
  attachPersistence(storage: vscode.Uri, dvVersion: string): void {
    this.dvVersionSegment = encodeURIComponent(dvVersion);
    this.cacheDir = path.join(storage.fsPath, 'commit-content', this.dvVersionSegment);
    void fs.mkdir(this.cacheDir, { recursive: true });
    void this.evictIfOverCap();
  }

  invalidate(absFsPath: string): void {
    for (const key of [...this.memCache.keys()]) {
      const u = vscode.Uri.parse(key);
      if (u.path === absFsPath) {
        this.memCache.delete(key);
        this._onDidChange.fire(u);
      }
    }
  }

  invalidateAll(): void {
    for (const key of this.memCache.keys()) this._onDidChange.fire(vscode.Uri.parse(key));
    this.memCache.clear();
  }

  /**
   * Drop both the in-memory and on-disk caches. Returns the number of bytes
   * and files freed from disk so callers can surface it to the user. Used by
   * the `Diversion: Clear Commit Content Cache` command for benchmarking and
   * for recovery when a corrupt entry sneaks in.
   */
  async clearAll(): Promise<{ files: number; bytes: number; cacheDir: string | undefined }> {
    this.invalidateAll();
    if (!this.cacheDir) return { files: 0, bytes: 0, cacheDir: undefined };
    let files = 0;
    let bytes = 0;
    try {
      const entries = await fs.readdir(this.cacheDir);
      for (const name of entries) {
        const file = path.join(this.cacheDir, name);
        const st = await fs.stat(file).catch(() => undefined);
        if (!st || !st.isFile()) continue;
        await fs.unlink(file).catch(() => {/* best-effort */});
        files++;
        bytes += st.size;
      }
    } catch (err) {
      this.logger.warn(`[dv-commit] clearAll failed: ${(err as Error).message}`);
    }
    this.logger.info(`[dv-commit] cleared ${files} cache file(s), ${(bytes / 1024).toFixed(1)}KB`);
    return { files, bytes, cacheDir: this.cacheDir };
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    let entry = this.memCache.get(key);
    if (!entry) {
      entry = this.compute(uri).catch((err) => {
        this.logger.warn(`[dv-commit] resolve failed for ${uri.toString()}: ${(err as Error).message}`);
        return '';
      });
      this.memCache.set(key, entry);
    }
    return entry;
  }

  /**
   * Pre-warm the cache for an entire commit. Two paths:
   *
   *   1. **Single call** (small commits or no file list): one
   *      `dv diff --base <commit>` produces every file's diff in one shot.
   *      Cheaper for small commits; the original prefetch behaviour.
   *
   *   2. **Chunked parallel** (large commits with a known file list): split
   *      the file list into chunks of {@link PREFETCH_CHUNK_SIZE} and run
   *      `dv diff --base <commit> <chunk-paths>` calls concurrently. The
   *      shared semaphore in `cli.ts` caps actual parallelism to whatever
   *      the user has configured via `diversion.maxParallelProcesses`, so
   *      this naturally exercises that setting on big commits.
   *
   * Trade-off: chunking costs extra process spawns and daemon round-trips
   * but lets the daemon's cloud fetches run in parallel — a 30s monolithic
   * call on a 400-file commit becomes ~30s/N where N is the cap (assuming
   * the cloud side parallelises, which is the usual case).
   */
  async prefetchAtCommit(
    commitId: string,
    repoRoot: string,
    dvPath: string | undefined,
    files?: readonly string[],
  ): Promise<void> {
    const tStart = Date.now();

    // Single-call path: small commit or caller couldn't supply a file list.
    if (!files || files.length <= PREFETCH_CHUNK_SIZE) {
      return this.prefetchSingleCall(commitId, repoRoot, dvPath, tStart);
    }

    // Chunked path: split files across N parallel `dv diff <paths…>` calls.
    const chunks = chunkArray(files, PREFETCH_CHUNK_SIZE);
    const results = await Promise.all(
      chunks.map((chunk, i) => this.prefetchChunk(commitId, repoRoot, dvPath, chunk, i)),
    );

    let warmed = 0;
    let cached = 0;
    let bytes = 0;
    let dvMsTotal = 0;
    let total = 0;
    for (const r of results) {
      warmed += r.warmed;
      cached += r.cached;
      bytes += r.bytes;
      dvMsTotal += r.dvMs;
      total += r.total;
    }
    this.logger.info(
      `[dv-commit] prefetch ${commitId} · ${chunks.length} chunk(s), ` +
      `wall=${Date.now() - tStart}ms (sum-of-dv=${dvMsTotal}ms) · ` +
      `${warmed} warmed, ${cached} already cached, ${total} total · ` +
      `${(bytes / 1024).toFixed(1)}KB diff`,
    );
  }

  private async prefetchSingleCall(
    commitId: string,
    repoRoot: string,
    dvPath: string | undefined,
    tStart: number,
  ): Promise<void> {
    let r;
    try {
      r = await runDv(
        ['diff', '--color', 'never', '--base', commitId],
        { cwd: repoRoot, dvPath, timeoutMs: 60_000 },
      );
    } catch (err) {
      this.logger.warn(`[dv-commit] prefetch dv diff threw for ${commitId}: ${(err as Error).message}`);
      return;
    }
    const tAfterDv = Date.now();
    if (r.exitCode !== 0) {
      this.logger.warn(`[dv-commit] prefetch dv diff exited ${r.exitCode} for ${commitId}`);
      return;
    }

    const trimmed = r.stdout.trim();
    if (!trimmed || /^no changes/i.test(trimmed)) {
      this.logger.info(
        `[dv-commit] prefetch ${commitId}: no diff vs workspace · ${tAfterDv - tStart}ms`,
      );
      return;
    }

    const perFile = splitMultiFileDiff(r.stdout);
    let warmed = 0;
    let cached = 0;
    for (const [relPath, fileDiff] of perFile) {
      const absPath = path.join(repoRoot, relPath);
      const uri = commitContentUri(absPath, commitId);
      const cacheKey = uri.toString();
      if (this.memCache.has(cacheKey)) { cached++; continue; }

      const promise = this.computeFromCachedDiff(absPath, commitId, relPath, fileDiff);
      this.memCache.set(cacheKey, promise);
      warmed++;
    }
    this.logger.info(
      `[dv-commit] prefetch ${commitId} · dv=${tAfterDv - tStart}ms · ` +
      `${warmed} warmed, ${cached} already cached, ${perFile.size} total · ` +
      `${(r.stdout.length / 1024).toFixed(1)}KB diff`,
    );
  }

  private async prefetchChunk(
    commitId: string,
    repoRoot: string,
    dvPath: string | undefined,
    paths: readonly string[],
    chunkIndex: number,
  ): Promise<{ warmed: number; cached: number; total: number; bytes: number; dvMs: number }> {
    const tStart = Date.now();
    let r;
    try {
      r = await runDv(
        ['diff', '--color', 'never', '--base', commitId, ...paths],
        { cwd: repoRoot, dvPath, timeoutMs: 60_000 },
      );
    } catch (err) {
      this.logger.warn(
        `[dv-commit] prefetch chunk #${chunkIndex} threw for ${commitId}: ${(err as Error).message}`,
      );
      return { warmed: 0, cached: 0, total: 0, bytes: 0, dvMs: Date.now() - tStart };
    }
    const dvMs = Date.now() - tStart;
    if (r.exitCode !== 0) {
      this.logger.warn(
        `[dv-commit] prefetch chunk #${chunkIndex} exit ${r.exitCode} for ${commitId}`,
      );
      return { warmed: 0, cached: 0, total: 0, bytes: 0, dvMs };
    }

    const trimmed = r.stdout.trim();
    if (!trimmed || /^no changes/i.test(trimmed)) {
      return { warmed: 0, cached: 0, total: 0, bytes: r.stdout.length, dvMs };
    }

    const perFile = splitMultiFileDiff(r.stdout);
    let warmed = 0;
    let cached = 0;
    for (const [relPath, fileDiff] of perFile) {
      const absPath = path.join(repoRoot, relPath);
      const uri = commitContentUri(absPath, commitId);
      const cacheKey = uri.toString();
      if (this.memCache.has(cacheKey)) { cached++; continue; }

      const promise = this.computeFromCachedDiff(absPath, commitId, relPath, fileDiff);
      this.memCache.set(cacheKey, promise);
      warmed++;
    }
    return {
      warmed,
      cached,
      total: perFile.size,
      bytes: r.stdout.length,
      dvMs,
    };
  }

  private async computeFromCachedDiff(
    absPath: string,
    commitId: string,
    relPath: string,
    fileDiff: string,
  ): Promise<string> {
    // Try disk first — commits are immutable, so a hit means we can skip
    // the read+reverse-apply entirely.
    const persisted = await this.readFromDisk(commitId, relPath);
    if (persisted !== undefined) return persisted;

    if (await looksBinary(absPath)) return '';

    let working: string;
    try {
      working = await fs.readFile(absPath, 'utf8');
    } catch {
      return '';
    }

    const diff = parseUnifiedDiff(fileDiff);
    if (diff.binary) return '';
    const at = reverseApply(working, diff) ?? '';
    void this.writeToDisk(commitId, relPath, at);
    return at;
  }

  private async compute(uri: vscode.Uri): Promise<string> {
    const tStart = Date.now();
    if (uri.scheme !== DV_COMMIT_SCHEME) return '';
    const params = new URLSearchParams(uri.query);
    const commitId = params.get('commit');
    if (!commitId) return '';

    const fsPath = uri.path;
    const lookup = this.lookup.rootForPath(fsPath);
    if (!lookup) {
      this.logger.warn(`[dv-commit] no repo for ${fsPath}`);
      return '';
    }
    const relPath = toForwardSlashes(path.relative(lookup.root, fsPath) || fsPath);

    // Disk cache — commits are immutable so this is always trustworthy
    // (modulo dv version, which we segment by).
    const fromDisk = await this.readFromDisk(commitId, relPath);
    if (fromDisk !== undefined) {
      this.logger.info(`[dv-commit] ${commitId} ${relPath} · disk-cache hit · ${Date.now() - tStart}ms`);
      return fromDisk;
    }

    if (await looksBinary(fsPath)) return '';

    let working: string;
    try {
      working = await fs.readFile(fsPath, 'utf8');
    } catch {
      return '';
    }
    const tAfterRead = Date.now();

    const r = await runDv(
      ['diff', '--color', 'never', '--base', commitId, relPath],
      { cwd: lookup.root, dvPath: lookup.dvPath, timeoutMs: 30_000 },
    );
    const tAfterDv = Date.now();
    if (r.exitCode !== 0) {
      this.logger.warn(`[dv-commit] dv diff exited ${r.exitCode} for ${commitId} ${relPath}`);
      return '';
    }

    const stdout = r.stdout;
    const trimmed = stdout.trim();
    if (!trimmed || /^no changes/i.test(trimmed)) {
      void this.writeToDisk(commitId, relPath, working);
      this.logger.info(
        `[dv-commit] ${commitId} ${relPath} unchanged · ` +
        `total=${Date.now() - tStart}ms (dv=${tAfterDv - tAfterRead}ms)`
      );
      return working;
    }
    const diff = parseUnifiedDiff(stdout);
    if (diff.binary) return '';

    const at = reverseApply(working, diff) ?? '';
    void this.writeToDisk(commitId, relPath, at);
    const total = Date.now() - tStart;
    this.logger.info(
      `[dv-commit] ${commitId} ${relPath} · total=${total}ms ` +
      `(read=${tAfterRead - tStart}ms, dv=${tAfterDv - tAfterRead}ms, ` +
      `parse+apply=${Date.now() - tAfterDv}ms, dv-bytes=${stdout.length})`
    );
    return at;
  }

  // ───── disk-backed cache ─────

  private cacheFile(commitId: string, relPath: string): string | undefined {
    if (!this.cacheDir) return undefined;
    const key = `${commitId}::${relPath}`;
    const hash = crypto.createHash('sha1').update(key).digest('hex');
    return path.join(this.cacheDir, `${hash}.txt`);
  }

  private async readFromDisk(commitId: string, relPath: string): Promise<string | undefined> {
    const file = this.cacheFile(commitId, relPath);
    if (!file) return undefined;
    try {
      const buf = await fs.readFile(file);
      // Touch atime/mtime so LRU eviction tracks recency.
      const now = new Date();
      void fs.utimes(file, now, now).catch(() => {/* best-effort */});
      return buf.toString('utf8');
    } catch {
      return undefined;
    }
  }

  private async writeToDisk(commitId: string, relPath: string, content: string): Promise<void> {
    const file = this.cacheFile(commitId, relPath);
    if (!file) return;
    try {
      await fs.writeFile(file + '.tmp', content);
      await fs.rename(file + '.tmp', file);
    } catch (err) {
      this.logger.debug(`[dv-commit] cache write failed: ${(err as Error).message}`);
    }
  }

  private async evictIfOverCap(): Promise<void> {
    if (!this.cacheDir) return;
    try {
      const entries = await fs.readdir(this.cacheDir);
      let total = 0;
      const stats: { file: string; size: number; mtime: number }[] = [];
      for (const name of entries) {
        const file = path.join(this.cacheDir, name);
        const st = await fs.stat(file).catch(() => undefined);
        if (!st || !st.isFile()) continue;
        total += st.size;
        stats.push({ file, size: st.size, mtime: st.mtimeMs });
      }
      if (total <= DISK_CACHE_BYTE_LIMIT) return;

      // Evict oldest first until under cap.
      stats.sort((a, b) => a.mtime - b.mtime);
      let evicted = 0;
      for (const s of stats) {
        if (total <= DISK_CACHE_BYTE_LIMIT) break;
        await fs.unlink(s.file).catch(() => {/* best-effort */});
        total -= s.size;
        evicted++;
      }
      this.logger.info(`[dv-commit] cache eviction: ${evicted} file(s) removed, now ${(total / 1024 / 1024).toFixed(1)}MB`);
    } catch (err) {
      this.logger.debug(`[dv-commit] cache scan failed: ${(err as Error).message}`);
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.memCache.clear();
  }
}
