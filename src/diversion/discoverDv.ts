import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Find an installed `dv` binary when a plain PATH lookup has already failed.
 *
 * This matters more since Diversion shipped a Homebrew cask: a GUI-launched
 * VS Code on macOS inherits a minimal PATH (often just /usr/bin:/bin), so
 * `dv` can be perfectly well installed and still be unspawnable from the
 * extension host. Rather than telling the user to go configure a path, we
 * look in the places installers actually put it.
 *
 * Only absolute, well-known *system* locations are probed — never anything
 * derived from the workspace, which would let a repo point us at a binary it
 * ships. `resolveDvPath` enforces the same rule from the other direction.
 *
 * `~/.diversion/bin/dv` is the location verified in practice (the curl
 * installer's). The rest are best-effort guesses at the packaged installs;
 * a wrong guess costs one failed `stat` and nothing else.
 */
export function dvCandidatePaths(platform: NodeJS.Platform = process.platform): string[] {
  const home = os.homedir();
  const env = process.env;
  const candidates: string[] = [];

  if (platform === 'win32') {
    const exe = 'dv.exe';
    for (const base of [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']]) {
      if (!base) continue;
      candidates.push(
        path.join(base, 'Programs', 'Diversion', exe),
        path.join(base, 'Diversion', exe),
        path.join(base, 'Diversion', 'bin', exe),
      );
    }
    candidates.push(path.join(home, '.diversion', 'bin', exe));
    return dedupe(candidates);
  }

  candidates.push(path.join(home, '.diversion', 'bin', 'dv'));

  if (platform === 'darwin') {
    candidates.push(
      // Homebrew, Apple silicon then Intel.
      '/opt/homebrew/bin/dv',
      '/usr/local/bin/dv',
      // Inside the cask's app bundle, if the shim never got linked.
      '/Applications/Diversion.app/Contents/MacOS/dv',
      '/Applications/Diversion.app/Contents/Resources/dv',
      path.join(home, 'Applications', 'Diversion.app', 'Contents', 'MacOS', 'dv'),
    );
  } else {
    candidates.push(
      path.join(home, '.local', 'bin', 'dv'),
      '/usr/local/bin/dv',
      '/usr/bin/dv',
      '/opt/diversion/bin/dv',
    );
  }
  return dedupe(candidates);
}

/**
 * First candidate that exists and is executable, or undefined. Never throws —
 * this runs on an error path where a second failure helps nobody.
 */
export async function discoverDvBinary(
  candidates: readonly string[] = dvCandidatePaths(),
): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Missing or not executable — try the next one.
    }
  }
  return undefined;
}

function dedupe(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}
