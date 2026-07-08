import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { Semaphore } from '../util/semaphore.js';

/**
 * Bounds the number of `dv` processes in flight at any one time. Clicking
 * around in the SCM Graph can easily fan out into many parallel `dv diff`
 * invocations; without a cap we'd thrash the daemon and the user's CPU.
 *
 * The default of 4 matches what feels good on a typical dev box; users can
 * tune it via the `diversion.maxParallelProcesses` setting which calls
 * {@link setDvConcurrencyLimit} from extension activation / config-change.
 */
const dvSemaphore = new Semaphore(4);

export function setDvConcurrencyLimit(n: number): void {
  dvSemaphore.setCapacity(n);
}

export function dvConcurrencyStats(): { inFlight: number; queued: number; capacity: number } {
  return dvSemaphore.stats();
}

/**
 * Notified when `spawn(dv)` fails with ENOENT (binary not found on PATH).
 * The extension registers a handler that surfaces a one-shot, actionable
 * error toast — without this, repeated refresh/lock/QuickDiff failures
 * each log silently and the user sees no UI cue that anything is wrong.
 *
 * Module-level rather than per-call so the cli module stays vscode-free.
 */
let onDvMissingHandler: ((info: { dvPath: string; cause: NodeJS.ErrnoException }) => void) | undefined;
export function setOnDvMissing(
  handler: ((info: { dvPath: string; cause: NodeJS.ErrnoException }) => void) | undefined,
): void {
  onDvMissingHandler = handler;
}

/**
 * Minimal interface mirroring `vscode.CancellationToken` so this module can
 * stay framework-free and unit-testable without pulling in `vscode`.
 */
export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface DvRunOptions {
  /** Working directory. Required — every dv invocation is repo-scoped. */
  cwd: string;
  /** Cancellation hook (typically a `vscode.CancellationToken`). */
  token?: CancellationLike;
  /** Stdin payload (rarely needed; commit messages go via -m flag). */
  stdin?: string;
  /** Hard timeout in ms. Default: 60_000. Pass 0 for no timeout. */
  timeoutMs?: number;
  /** Path to the `dv` binary. Default: `'dv'` (resolved via PATH). */
  dvPath?: string;
  /** Extra environment variables. */
  env?: NodeJS.ProcessEnv;
  /**
   * Cap on combined stdout+stderr bytes buffered before the process is killed
   * and the call rejects. Guards the extension host against OOM on a
   * pathologically large diff/status. Default {@link DEFAULT_MAX_BYTES};
   * pass 0 to disable.
   */
  maxBytes?: number;
}

/** Default cap on buffered dv output (see {@link DvRunOptions.maxBytes}). */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface DvResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
}

/**
 * `dv` returns exit 0 even for "not in a repo" type errors, printing the
 * error to stdout. Callers detect failures by inspecting these patterns;
 * the runner itself does not raise on non-zero exit.
 */
const KNOWN_ERROR_PATTERNS: readonly RegExp[] = [
  /^Current directory is not a diversion repository/i,
  /^Error:/i,
  /^error:/,
  /^Failed to /i,
];

export class DvError extends Error {
  constructor(
    message: string,
    readonly result: DvResult,
    readonly args: readonly string[],
  ) {
    super(message);
    this.name = 'DvError';
  }
}

/**
 * Run `dv` with the given args. Returns stdout/stderr/exit; never throws on
 * non-zero exit alone — callers must inspect the result. Use {@link runDvOrThrow}
 * for the throw-on-failure variant.
 */
export function runDv(args: readonly string[], opts: DvRunOptions): Promise<DvResult> {
  return dvSemaphore.run(() => spawnDv(args, opts));
}

/** Grace between SIGTERM and SIGKILL when terminating a dv process. */
const TERM_GRACE_MS = 2_000;
/**
 * Grace between SIGKILL and abandoning the process (settling the promise
 * anyway). If dv is blocked in uninterruptible I/O on a wedged network mount
 * even SIGKILL won't reap it promptly — but we must still settle so the
 * semaphore slot is released, or a few hangs deadlock every future dv call.
 */
const KILL_GRACE_MS = 3_000;

/**
 * Resolve the `dv` binary to spawn, rejecting the one shape that is a
 * privilege-escalation vector: a *relative* path containing a separator
 * (e.g. `./tools/dv`). Because we spawn with `cwd` set to the repo root, such
 * a value resolves against the repo itself — so a malicious repo could ship
 * both a `.vscode/settings.json` pointing `diversion.path` there and the
 * binary, and merely opening the folder would execute it. `diversion.path`
 * is also `machine`-scoped in package.json (workspace settings can't override
 * it); this is defense-in-depth that also covers the MCP env-var path.
 *
 * Allowed: empty (PATH lookup of the platform default), a bare command name
 * with no separator (PATH lookup), or an absolute path the user configured on
 * their own machine.
 */
export function resolveDvPath(configured: string | undefined): string {
  const trimmed = configured?.trim();
  if (!trimmed) return process.platform === 'win32' ? 'dv.exe' : 'dv';
  const hasSeparator = /[\\/]/.test(trimmed);
  if (hasSeparator && !path.isAbsolute(trimmed)) {
    throw new Error(
      `Refusing to run dv from a relative path "${trimmed}" — set diversion.path ` +
      `to an absolute path or a bare command name on PATH.`,
    );
  }
  return trimmed;
}

function spawnDv(args: readonly string[], opts: DvRunOptions): Promise<DvResult> {
  // Resolve the dv binary. Settings can override; otherwise default to the
  // platform-conventional name so PATH lookups work without shell expansion.
  // Node's `spawn` (without `shell: true`) does NOT apply Windows PATHEXT,
  // so plain "dv" wouldn't find "dv.exe" on Windows.
  const dvPath = resolveDvPath(opts.dvPath);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return new Promise<DvResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(dvPath, [...args], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    // `exited` is the real liveness signal — it flips only in the `close`/
    // `error` handlers when the process is actually gone. `child.killed`
    // cannot be used for this: it becomes true the instant a signal is
    // *delivered* (i.e. right after SIGTERM), so guarding SIGKILL on
    // `!child.killed` — as this code previously did — meant SIGKILL never
    // fired and a hung dv leaked its semaphore slot forever.
    let exited = false;
    // Guards single settlement — an output-cap failFast can race the close
    // event, and the watchdog can race a late exit.
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    let tokenListener: { dispose(): void } | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (watchdog) clearTimeout(watchdog);
      tokenListener?.dispose();
    };

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    const onData = (chunks: Buffer[]) => (c: Buffer): void => {
      chunks.push(c);
      totalBytes += c.length;
      if (maxBytes > 0 && totalBytes > maxBytes) {
        // Reject immediately (don't wait for exit) and hard-kill; a runaway
        // diff must not pin the extension host's heap.
        if (settled) return;
        settled = true;
        cleanup();
        child.kill('SIGKILL');
        reject(new Error(
          `dv ${args.join(' ')} produced more than ${maxBytes} bytes of output; aborted`,
        ));
      }
    };
    child.stdout?.on('data', onData(stdoutChunks));
    child.stderr?.on('data', onData(stderrChunks));

    // SIGTERM → SIGKILL → abandon. The final stage rejects the promise even
    // if the OS never reaps the process, which is what reclaims the
    // semaphore slot when dv wedges.
    const terminate = (reason: string): void => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, TERM_GRACE_MS);
      watchdog = setTimeout(() => {
        if (exited || settled) return;
        settled = true;
        cleanup();
        reject(new Error(`dv ${args.join(' ')} ${reason} and did not exit; abandoning process`));
      }, TERM_GRACE_MS + KILL_GRACE_MS);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => terminate(`timed out after ${timeoutMs}ms`), timeoutMs);
    }
    tokenListener = opts.token?.onCancellationRequested(() => terminate('was cancelled'));

    child.on('error', (err) => {
      exited = true;
      if (settled) return;
      settled = true;
      cleanup();
      const errno = err as NodeJS.ErrnoException;
      if (errno.code === 'ENOENT' && onDvMissingHandler) {
        try { onDvMissingHandler({ dvPath, cause: errno }); }
        catch { /* handler is best-effort; don't mask the original reject */ }
      }
      reject(err);
    });

    child.on('close', (code, signal) => {
      exited = true;
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code ?? -1,
        signal,
      });
    });

    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.end(opts.stdin);
    }
  });
}

/**
 * Run `dv` and throw if the result looks like a failure. Failure detection:
 *   - non-zero exit, OR
 *   - exit 0 but stdout/stderr matches a known error pattern.
 */
export async function runDvOrThrow(
  args: readonly string[],
  opts: DvRunOptions,
): Promise<DvResult> {
  const result = await runDv(args, opts);
  if (result.exitCode !== 0) {
    throw new DvError(
      `dv ${args.join(' ')} exited with code ${result.exitCode}: ${trimErr(result)}`,
      result,
      args,
    );
  }
  if (looksLikeError(result.stdout) || looksLikeError(result.stderr)) {
    throw new DvError(
      `dv ${args.join(' ')} reported an error: ${trimErr(result)}`,
      result,
      args,
    );
  }
  return result;
}

/** Public test hook + production helper: detect dv's exit-0 errors. */
export function looksLikeError(text: string): boolean {
  const head = text.split(/\r?\n/, 1)[0] ?? '';
  return KNOWN_ERROR_PATTERNS.some((p) => p.test(head));
}

function trimErr(r: DvResult): string {
  return summarizeDvError(r.stderr || r.stdout || '');
}

const DETAIL_RE = /"detail"\s*:\s*"((?:[^"\\]|\\.)+)"/;
const STATUS_RE = /"status"\s*:\s*(\d{3})/;
const APOLOGY_RES: readonly RegExp[] = [
  /^Oh no, looks like something went wrong/i,
  /^An engineer has been notified/i,
  /^Please run `?dv support`?/i,
  /^Your files are safe/i,
];

/**
 * Strip the boilerplate apology text that dv emits for backend errors and
 * extract the operative bits (HTTP status + the embedded JSON `detail`).
 *
 * `dv lock` on a non-paid tier currently returns a multi-line "Oh no…"
 * message wrapping a JSON `{"status":403,"detail":"…"}` payload — this
 * helper distills that to `(403) Hard locks require a Studio or
 * Enterprise subscription`.
 */
export function summarizeDvError(text: string): string {
  if (!text) return '';
  const detail = DETAIL_RE.exec(text)?.[1];
  const status = STATUS_RE.exec(text)?.[1];
  if (detail) {
    const cleaned = detail.replace(/\\"/g, '"').replace(/\\n/g, ' ');
    return status ? `(${status}) ${cleaned}` : cleaned;
  }

  // No JSON detail — return the first meaningful line, skipping apology noise.
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (APOLOGY_RES.some((p) => p.test(line))) continue;
    if (line.startsWith('[failed to execute')) continue;
    return line.length > 200 ? line.slice(0, 200) + '…' : line;
  }
  return text.split(/\r?\n/, 1)[0]!.slice(0, 200);
}
