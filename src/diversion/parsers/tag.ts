export interface TagInfo {
  /** Stable ID, e.g. `dv.tag.<n>`. */
  id: string;
  /** Display name. */
  name: string;
  /** Commit the tag points at, if dv prints it. */
  commitId?: string;
  /** Optional description / message. */
  description?: string;
  /** Author or creator if dv prints one. */
  author?: string;
  /** Date string as returned by dv. */
  date?: string;
}

interface TagJsonItem {
  id?: string;
  ID?: string;
  name?: string;
  Name?: string;
  ref?: string;
  Ref?: string;
  commit_id?: string;
  CommitID?: string;
  description?: string;
  Description?: string;
  message?: string;
  Message?: string;
  author?: string;
  Author?: string;
  date?: string;
  Date?: string;
  created_at?: string;
  CreatedAt?: string;
}

interface TagJsonEnvelope {
  object?: string;
  items?: TagJsonItem[];
}

/**
 * Parse `dv tag --json` output. The envelope is `{"object":"Tag","items":[...]}`;
 * field casing inside each item drifts across dv versions (PascalCase from the
 * Go backend vs snake_case from the wrapper) so we accept both.
 */
export function parseTagList(stdout: string): TagInfo[] {
  if (!stdout.trim()) return [];
  let env: TagJsonEnvelope;
  try {
    env = JSON.parse(stdout) as TagJsonEnvelope;
  } catch {
    return [];
  }
  if (!env.items || !Array.isArray(env.items)) return [];
  const out: TagInfo[] = [];
  for (const item of env.items) {
    const id = item.id ?? item.ID;
    const name = item.name ?? item.Name;
    if (!id || !name) continue;
    const tag: TagInfo = { id, name };
    const commitId = item.commit_id ?? item.CommitID ?? item.ref ?? item.Ref;
    if (commitId) tag.commitId = commitId;
    const description = item.description ?? item.Description ?? item.message ?? item.Message;
    if (description) tag.description = description;
    const author = item.author ?? item.Author;
    if (author) tag.author = author;
    const date = item.date ?? item.Date ?? item.created_at ?? item.CreatedAt;
    if (date) tag.date = date;
    out.push(tag);
  }
  return out;
}
