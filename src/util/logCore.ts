export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export const LEVEL_RANK: Record<LogLevel, number> = {
  off: 0, error: 1, warn: 2, info: 3, debug: 4,
};

/**
 * Minimal logger contract that host-agnostic modules under `src/diversion/`
 * depend on. Both the VS Code `Logger` (output channel) and the MCP
 * server's `StderrLogger` satisfy it, so the same core code runs in
 * either environment.
 */
export interface LoggerLike {
  error(msg: string, err?: unknown): void;
  warn(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
}

/**
 * stderr-backed logger for environments without a VS Code output channel
 * (the stdio MCP server, scripts, tests). Honors the same LogLevel scale;
 * reads `DIVERSION_LOG_LEVEL` from the env on construction unless an
 * explicit level is supplied.
 *
 * Lives in this file (separate from the vscode-backed Logger) so the MCP
 * bundle never reaches for `vscode` at import time.
 */
export class StderrLogger implements LoggerLike {
  constructor(private level: LogLevel = readEnvLevel()) {}
  setLevel(level: LogLevel): void { this.level = level; }
  error(msg: string, err?: unknown): void { this.write('error', msg, err); }
  warn(msg: string): void { this.write('warn', msg); }
  info(msg: string): void { this.write('info', msg); }
  debug(msg: string): void { this.write('debug', msg); }

  private write(level: LogLevel, msg: string, err?: unknown): void {
    if (LEVEL_RANK[level] > LEVEL_RANK[this.level]) return;
    const ts = new Date().toISOString();
    process.stderr.write(`[${ts}] [${level}] ${msg}\n`);
    if (err !== undefined) {
      const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(text + '\n');
    }
  }
}

function readEnvLevel(): LogLevel {
  const v = (process.env.DIVERSION_LOG_LEVEL ?? 'info').toLowerCase();
  return (['off', 'error', 'warn', 'info', 'debug'] as const).includes(v as LogLevel)
    ? (v as LogLevel)
    : 'info';
}
