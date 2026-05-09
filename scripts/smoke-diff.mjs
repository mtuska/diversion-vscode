// Reproduce the exact spawn the extension uses for `dv diff <abspath>` and
// dump the result. Lets us see whether the "no changes" reply is from dv
// itself or from our wiring.
import { spawn } from 'node:child_process';

const cwd = process.argv[2] ?? '/path/to/dv-repo';
const target = process.argv[3] ?? '/path/to/dv-repo/Documentation/plans/overview.md';

console.log('cwd:    ', cwd);
console.log('target: ', target);

const child = spawn('dv', ['diff', '--color', 'never', target], {
  cwd,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let out = '', err = '';
child.stdout.on('data', (c) => { out += c; });
child.stderr.on('data', (c) => { err += c; });
child.on('close', (code, signal) => {
  console.log(`exit: ${code} signal: ${signal}`);
  console.log('--- stdout ---');
  console.log(out);
  console.log('--- stderr ---');
  console.log(err);
});
