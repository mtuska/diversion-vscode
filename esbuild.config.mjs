import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// Inject the package version at build time so the CoreAPI client can send it
// as X-DV-App-Version. tsconfig's rootDir:src forbids importing package.json
// directly, and a build-time define keeps both bundles in sync with no
// runtime file read.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const define = { __APP_VERSION__: JSON.stringify(version) };

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  define,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const mcpConfig = {
  entryPoints: ['src/mcp/index.ts'],
  bundle: true,
  outfile: 'out/mcp.js',
  // The MCP server is a standalone Node process — it must never reach for
  // the `vscode` host module. Leaving `vscode` *out* of `external` means
  // esbuild will fail the build if anything in the MCP entry's import
  // tree accidentally pulls it in, instead of producing a binary that
  // explodes at runtime. Format is `cjs` (same as the extension bundle)
  // because the package isn't ESM-typed and node loads `.js` as CJS by
  // default; the banner adds the shebang so this file is directly
  // executable via the `diversion-mcp` bin entry.
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  define,
  sourcemap: !production,
  minify: production,
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
};

if (watch) {
  const [extCtx, mcpCtx] = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(mcpConfig),
  ]);
  await Promise.all([extCtx.watch(), mcpCtx.watch()]);
  console.log('[esbuild] watching extension + mcp for changes…');
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(mcpConfig),
  ]);
}
