import { spawn, type ChildProcess } from 'node:child_process';
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
}

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

function spawnDv(args: readonly string[], opts: DvRunOptions): Promise<DvResult> {
  // Resolve the dv binary. Settings can override; otherwise default to the
  // platform-conventional name so PATH lookups work without shell expansion.
  // Node's `spawn` (without `shell: true`) does NOT apply Windows PATHEXT,
  // so plain "dv" wouldn't find "dv.exe" on Windows.
  const dvPath = opts.dvPath ?? (process.platform === 'win32' ? 'dv.exe' : 'dv');
  const timeoutMs = opts.timeoutMs ?? 60_000;

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

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        // Hard-kill if it doesn't exit promptly.
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2000);
      }, timeoutMs);
    }

    const tokenListener = opts.token?.onCancellationRequested(() => {
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 1000);
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      tokenListener?.dispose();
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      tokenListener?.dispose();
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
