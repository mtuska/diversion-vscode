export interface RepoListEntry {
  name: string;
  /** Stable repo ID, e.g. `dv.repo.<uuid>`. */
  id: string;
  /** Local clone path if the repo is cloned on this machine. */
  localPath?: string;
  /** True if the repo is cloned to this machine. */
  cloned: boolean;
}

const ENTRY_RE = /^(\S.*?)\s*\((dv\.repo\.[^)]+)\)(?:\s*\(([^)]+)\))?\s*$/;

/**
 * Parse `dv repo` output. Format is two sections separated by headers:
 *
 *   Cloned Locally:
 *   <name> (dv.repo.<id>)(/local/path)
 *
 *   Other:
 *   <name> (dv.repo.<id>)
 *
 * Lines that don't match the entry regex (blank lines, unknown headers) are
 * skipped. Unknown sections default to "not cloned"; only entries appearing
 * under "Cloned Locally" get `cloned: true`.
 */
export function parseRepoList(stdout: string): RepoListEntry[] {
  const out: RepoListEntry[] = [];
  let inCloned = false;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^cloned locally:?$/i.test(line)) { inCloned = true; continue; }
    if (/^other:?$/i.test(line) || /^remote:?$/i.test(line)) { inCloned = false; continue; }
    const m = ENTRY_RE.exec(line);
    if (!m) continue;
    const entry: RepoListEntry = {
      name: m[1]!,
      id: m[2]!,
      cloned: inCloned,
    };
    if (m[3]) entry.localPath = m[3];
    out.push(entry);
  }
  return out;
}
