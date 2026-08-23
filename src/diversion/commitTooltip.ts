import { formatDateTime } from '../util/dates.js';
import type { CommitDetails } from './types.js';

/**
 * Markdown for a commit's hover card in the Source Control Graph: the full
 * message, then the identifying details under a rule — commit ID, author,
 * date — the way git's SCM shows them.
 *
 * Without this the graph hover is only the subject line, so the commit ID —
 * the thing you need in order to cherry-pick, tag, or compare — is nowhere in
 * the UI. Kept free of `vscode` imports so it can be tested directly.
 */
export function formatCommitTooltip(c: CommitDetails): string {
  const parts: string[] = [];
  const message = c.message.trim();
  // Hard line breaks (two trailing spaces) so a wrapped commit body keeps its
  // shape instead of collapsing into one paragraph.
  if (message) parts.push(escapeMarkdown(message).replace(/\n/g, '  \n'));

  const who = c.authorName || 'unknown';
  const email = c.authorEmail ? ` <${c.authorEmail}>` : '';
  const details = [
    `\`${c.id}\``,
    escapeMarkdown(who + email),
  ];
  const when = formatDateTime(c.date);
  if (when) details.push(escapeMarkdown(when));

  parts.push(details.join('  \n'));
  return parts.join('\n\n---\n\n');
}

/**
 * Neutralize the markdown that shows up in real commit messages — a leading
 * `#` turning a line into a heading, `*`/`_` swallowing words as emphasis.
 * The message should read exactly as it was written.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>]/g, (m) => '\\' + m);
}
