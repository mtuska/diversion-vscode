export interface Annotation {
  /** 1-based line number. */
  lineNumber: number;
  content: string;
  commitId: string | undefined;
  author: string | undefined;
  /** Raw date as printed by `dv annotate` — usually `YYYY-MM-DD`. */
  date: string | undefined;
  /** True if the line is locally uncommitted ("uncommitted" sentinel from dv). */
  uncommitted: boolean;
}

/**
 * Each annotation line looks like:
 *   `<commit_id>     <author>      <date>   <N>) <content>`
 * with continuation lines (same commit as the previous) printed as just
 * leading spaces followed by `<N>) <content>`. Uncommitted lines use the
 * sentinel `uncommitted        (uncommitted)             <N>)`.
 *
 * We don't rely on fixed columns — `dv` pads dynamically — but every line
 * has the `<N>) ` separator, which is the anchor we use to split metadata
 * from content. Metadata that's blank means "inherit from the previous block".
 */
const LINE_RE = /^(.*?)\s+(\d+)\)\s?(.*)$/;
const META_RE = /^(\S+)\s+(.+?)\s+(\d{4}-\d{2}-\d{2})\s*$/;

export function parseAnnotation(stdout: string): Annotation[] {
  const out: Annotation[] = [];
  let last: { commitId: string; author: string; date: string; uncommitted: boolean } | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw) continue;
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const metaRaw = m[1]!.trimEnd();
    const lineNumber = Number.parseInt(m[2]!, 10);
    const content = m[3] ?? '';
    const meta = metaRaw.trim();

    if (meta === '') {
      // Continuation — inherit previous block's metadata.
      out.push({
        lineNumber,
        content,
        commitId: last?.commitId,
        author: last?.author,
        date: last?.date,
        uncommitted: last?.uncommitted ?? false,
      });
      continue;
    }

    if (/^uncommitted\b/.test(meta)) {
      last = { commitId: 'uncommitted', author: '(uncommitted)', date: '', uncommitted: true };
    } else {
      const cm = META_RE.exec(meta);
      if (cm) {
        last = { commitId: cm[1]!, author: cm[2]!.trim(), date: cm[3]!, uncommitted: false };
      }
      // Anything else: keep `last` unchanged — treat as continuation.
    }
    out.push({
      lineNumber,
      content,
      commitId: last?.commitId,
      author: last?.author,
      date: last?.date,
      uncommitted: last?.uncommitted ?? false,
    });
  }
  return out;
}
