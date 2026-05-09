// Out-of-band smoke test for daemon + detect modules. Requires a built
// out/extension.js? No — we import the compiled TS via tsc-on-the-fly is
// overkill, so this script duplicates the minimum logic to exercise the
// daemon endpoints. Run with: node scripts/smoke-detect.mjs <path>
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

async function getJson(base, p) {
  return new Promise((resolve, reject) => {
    http.get(base + p, { timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if ((res.statusCode ?? 0) >= 400) return reject(new Error(`${p} → ${res.statusCode} ${body}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

const rawTarget = path.resolve(process.argv[2] ?? process.cwd());
const target = await fs.realpath(rawTarget).catch(() => rawTarget);
const port = (await fs.readFile(path.join(os.homedir(), '.diversion/.port'), 'utf8')).trim();
const base = `http://127.0.0.1:${port}`;

const health = await getJson(base, '/health');
console.log(`daemon: ${base} (dv ${health.Version})`);

const workspaces = await getJson(base, '/workspaces');
let match;
for (const w of Object.values(workspaces)) {
  const canon = await fs.realpath(w.Path).catch(() => path.resolve(w.Path));
  if (canon === target) { match = w; break; }
}
if (match) {
  console.log(`detected: ${match.RepoName} on ${match.BranchName} @ ${match.CommitID} (ws ${match.WorkspaceID})`);
} else {
  console.log(`no workspace registered for ${target}`);
  console.log('known workspaces:');
  for (const w of Object.values(workspaces)) console.log(`  - ${w.Path}`);
}
