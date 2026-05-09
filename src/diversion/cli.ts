import { spawn, type ChildProcess } from 'node:child_process';

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
  const dvPath = opts.dvPath ?? 'dv';
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
  const text = (r.stderr || r.stdout || '').trim();
  return text.length > 400 ? text.slice(0, 400) + '…' : text;
}
