import { runMcpServer } from './server.js';

runMcpServer().catch((err: unknown) => {
  process.stderr.write(`[mcp] fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
