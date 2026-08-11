import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { setDvConcurrencyLimit } from '../diversion/cli.js';
import { StderrLogger } from '../util/logCore.js';
import { RepoRegistry } from './repoRegistry.js';
import { registerAllTools } from './tools.js';

const PKG_NAME = 'diversion-mcp';
/**
 * Build-time stamped by esbuild from package.json (see esbuild.config.mjs);
 * falls back under tsc/vitest. Previously hardcoded, which meant every release
 * silently depended on someone remembering to hand-edit it.
 */
declare const __APP_VERSION__: string;
const PKG_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';

/**
 * Start the MCP server on stdio. Honors a small set of environment
 * variables so the server is configurable without command-line plumbing
 * (matching how MCP clients typically launch servers):
 *
 *   DIVERSION_DV_PATH       Override the `dv` binary location.
 *   DIVERSION_DAEMON_URL    Override the agent base URL (e.g. http://127.0.0.1:38825).
 *   DIVERSION_CORE_API_URL  Override the CoreAPI base URL (default https://api.diversion.dev/v0).
 *   DIVERSION_CORE_TOKEN    CoreAPI access token, used instead of asking the local
 *                           agent to mint one. For environments where the agent
 *                           isn't running, or if `/token/core` is ever gated. Not
 *                           refreshed — supply a live token.
 *   DIVERSION_MAX_PARALLEL  Cap on concurrent dv processes (default 4).
 *   DIVERSION_MCP_READONLY  If set (1/true/yes), register only read tools.
 *   DIVERSION_LOG_LEVEL     off|error|warn|info|debug
 *
 * Repos are auto-discovered via the dv agent's `/workspaces` registry,
 * with a CWD walk as a fallback when the agent is offline. Tool calls
 * can also pass a `repo` hint pointing at any path — the registry
 * registers it on the fly.
 */
export async function runMcpServer(): Promise<void> {
  const logger = new StderrLogger();

  const maxParallel = clampInt(process.env.DIVERSION_MAX_PARALLEL, 1, 32, 4);
  setDvConcurrencyLimit(maxParallel);

  const readOnly = isTruthy(process.env.DIVERSION_MCP_READONLY);

  const registry = new RepoRegistry(logger, {
    dvPath: process.env.DIVERSION_DV_PATH,
    daemonUrl: process.env.DIVERSION_DAEMON_URL,
    coreApiUrl: process.env.DIVERSION_CORE_API_URL,
    coreAccessToken: process.env.DIVERSION_CORE_TOKEN,
  });
  await registry.discover();

  const server = new McpServer(
    { name: PKG_NAME, version: PKG_VERSION },
    {
      instructions:
        'Diversion source-control tools for Diversion (dv) workspaces — branches, ' +
        'commits, shelves, locks, diffs, and merges. Diversion is NOT git; do not use ' +
        'git tooling on these repos. Call dv_list_repos first if you do not know which ' +
        'repos are registered. Multiple-repo mode requires the `repo` argument on every tool.',
    },
  );
  registerAllTools(server, registry, { readOnly });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(
    `MCP server "${PKG_NAME}" v${PKG_VERSION} ready on stdio` +
    (readOnly ? ' (read-only mode — write tools disabled).' : '.'),
  );

  const shutdown = (sig: NodeJS.Signals): void => {
    logger.info(`Received ${sig}, shutting down.`);
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function isTruthy(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}
