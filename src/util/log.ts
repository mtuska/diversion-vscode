import * as vscode from 'vscode';
import { LEVEL_RANK, type LogLevel, type LoggerLike } from './logCore.js';

export type { LogLevel, LoggerLike } from './logCore.js';
export { StderrLogger } from './logCore.js';

export class Logger implements LoggerLike {
  private channel: vscode.OutputChannel;
  private level: LogLevel;

  constructor(name = 'Diversion') {
    this.channel = vscode.window.createOutputChannel(name);
    this.level = readLevel();
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('diversion.log.level')) {
        this.level = readLevel();
      }
    });
  }

  show(): void { this.channel.show(true); }
  dispose(): void { this.channel.dispose(); }

  error(msg: string, err?: unknown): void { this.write('error', msg, err); }
  warn(msg: string): void { this.write('warn', msg); }
  info(msg: string): void { this.write('info', msg); }
  debug(msg: string): void { this.write('debug', msg); }

  private write(level: LogLevel, msg: string, err?: unknown): void {
    if (LEVEL_RANK[level] > LEVEL_RANK[this.level]) return;
    const ts = new Date().toISOString();
    this.channel.appendLine(`[${ts}] [${level}] ${msg}`);
    if (err !== undefined) {
      const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
      this.channel.appendLine(text);
    }
  }
}

function readLevel(): LogLevel {
  const v = vscode.workspace.getConfiguration('diversion').get<string>('log.level', 'info');
  return (['off', 'error', 'warn', 'info', 'debug'] as const).includes(v as LogLevel)
    ? (v as LogLevel)
    : 'info';
}
