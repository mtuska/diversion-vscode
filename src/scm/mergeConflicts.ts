import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildConflictText, hasConflictMarkers } from '../diversion/mergeMarkers.js';
import type { Repo } from '../diversion/repo.js';
import type { DetailedOpenMerge, MergeConflict } from '../diversion/types.js';
import type { Logger } from '../util/log.js';

/**
 * Drives per-block resolution of a *merge* conflict.
 *
 * Merge conflicts, unlike `.dv-conflict` sidecars, have no filesystem
 * representation: the merge is parked server-side and each conflicting path
 * exists only as two blobs behind the CoreAPI. So we materialise a scratch
 * file per conflict — the two sides diffed into standard conflict markers —
 * let the user resolve it with VS Code's built-in Merge Conflict actions,
 * then POST the result back and finalize.
 *
 * Scratch files live under the extension's storage rather than the workspace:
 * writing them into the repo would put them in `dv status` and invite an
 * accidental commit.
 */
export class MergeConflictResolver implements vscode.Disposable {
  /** Scratch file path → what it resolves, so submit knows where to send it. */
  private readonly pending = new Map<string, {
    repo: Repo;
    mergeId: string;
    conflict: MergeConflict;
  }>();

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly logger: Logger,
  ) {}

  /** Entry point: pick a merge, then work through its conflicts. */
  async start(repo: Repo, mergeId?: string): Promise<void> {
    let targetId = mergeId;
    if (!targetId) {
      const open = await repo.listOpenMerges();
      if (open.length === 0) {
        void vscode.window.showInformationMessage('Diversion: no unresolved merges.');
        return;
      }
      if (open.length === 1) {
        targetId = open[0]!.id;
      } else {
        const pick = await vscode.window.showQuickPick(
          open.map((m) => ({ label: `${m.otherRef} → ${m.baseRef}`, detail: m.id, id: m.id })),
          { placeHolder: 'Which merge?' },
        );
        if (!pick) return;
        targetId = pick.id;
      }
    }
    await this.showConflicts(repo, targetId);
  }

  private async showConflicts(repo: Repo, mergeId: string): Promise<void> {
    let merge: DetailedOpenMerge;
    try {
      merge = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Diversion: loading merge conflicts' },
        () => repo.getMerge(mergeId),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Diversion: could not load merge: ${(err as Error).message}`);
      return;
    }

    const unresolved = merge.conflicts.filter((c) => !c.resolved);
    if (merge.conflicts.length > 0 && unresolved.length === 0) {
      await this.offerFinalize(repo, merge);
      return;
    }
    if (merge.conflicts.length === 0) {
      void vscode.window.showInformationMessage(
        `Diversion: merge ${mergeId} reports no conflicts. It may already be finalizing.`,
      );
      return;
    }

    const pick = await vscode.window.showQuickPick(
      merge.conflicts.map((c) => ({
        label: `${c.resolved ? '$(check)' : '$(warning)'} ${c.path}`,
        description: c.resolved ? `resolved (${c.resolvedSide ?? 'custom'})` : 'unresolved',
        conflict: c,
      })),
      {
        placeHolder: `${unresolved.length} of ${merge.conflicts.length} conflict(s) left — ${merge.otherRef} → ${merge.baseRef}`,
        matchOnDescription: true,
      },
    );
    if (!pick) return;
    await this.resolveOne(repo, merge, pick.conflict);
  }

  private async resolveOne(
    repo: Repo,
    merge: DetailedOpenMerge,
    conflict: MergeConflict,
  ): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(edit) Resolve block by block…', action: 'blocks' as const },
        { label: '$(arrow-left) Keep current (destination branch)', action: 'base' as const },
        { label: '$(arrow-right) Keep incoming (source branch)', action: 'other' as const },
      ],
      { placeHolder: conflict.path },
    );
    if (!choice) return;

    try {
      if (choice.action === 'base' || choice.action === 'other') {
        const ref = choice.action === 'base' ? merge.baseRef : merge.otherRef;
        const p = choice.action === 'base' ? conflict.basePath : conflict.otherPath;
        const content = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: `Diversion: resolving ${conflict.path}` },
          async () => {
            const side = await repo.mergeSideContent(ref, p);
            await repo.resolveMergeConflict(merge.id, conflict.id, side, conflict.fileMode);
            return side;
          },
        );
        this.logger.info(`[merge] ${conflict.path} resolved to ${choice.action} (${content.length} bytes)`);
        await this.showConflicts(repo, merge.id);
        return;
      }

      const [mine, theirs] = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Diversion: fetching ${conflict.path}` },
        () => Promise.all([
          repo.mergeSideContent(merge.baseRef, conflict.basePath),
          repo.mergeSideContent(merge.otherRef, conflict.otherPath),
        ]),
      );
      const { text, conflictCount } = buildConflictText(mine, theirs, {
        ours: `Current (${merge.baseRef})`,
        theirs: `Incoming (${merge.otherRef})`,
      });

      const scratch = await this.writeScratch(merge.id, conflict, text);
      this.pending.set(scratch.fsPath, { repo, mergeId: merge.id, conflict });
      await vscode.window.showTextDocument(scratch);
      void vscode.window.showInformationMessage(
        conflictCount === 0
          ? `${conflict.path}: the two sides are identical — run "Submit Merge Resolution" to accept.`
          : `${conflict.path}: ${conflictCount} block(s). Resolve them, then run "Submit Merge Resolution".`,
        'Submit Merge Resolution',
      ).then((a) => {
        if (a === 'Submit Merge Resolution') void this.submit(scratch);
      });
    } catch (err) {
      void vscode.window.showErrorMessage(`Diversion: ${conflict.path}: ${(err as Error).message}`);
    }
  }

  /**
   * Send the scratch file's current contents back as the resolution for its
   * conflict. Called from the notification action or the command palette.
   */
  async submit(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      void vscode.window.showInformationMessage('Diversion: open a merge scratch file first.');
      return;
    }
    const entry = this.pending.get(target.fsPath);
    if (!entry) {
      void vscode.window.showInformationMessage(
        'Diversion: this file is not an in-progress merge resolution.',
      );
      return;
    }

    // Save first — the user has almost certainly just edited the buffer.
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === target.fsPath);
    if (doc?.isDirty) await doc.save();

    const content = await fs.readFile(target.fsPath, 'utf8');
    if (hasConflictMarkers(content)) {
      const proceed = await vscode.window.showWarningMessage(
        `${entry.conflict.path} still contains conflict markers. Submitting now would commit them.`,
        { modal: true }, 'Submit anyway',
      );
      if (proceed !== 'Submit anyway') return;
    }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Diversion: submitting ${entry.conflict.path}` },
        () => entry.repo.resolveMergeConflict(
          entry.mergeId, entry.conflict.id, content, entry.conflict.fileMode,
        ),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Diversion: submit failed: ${(err as Error).message}`);
      return;
    }

    this.pending.delete(target.fsPath);
    await fs.rm(target.fsPath, { force: true }).catch(() => undefined);
    await this.showConflicts(entry.repo, entry.mergeId);
  }

  private async offerFinalize(repo: Repo, merge: DetailedOpenMerge): Promise<void> {
    const go = await vscode.window.showInformationMessage(
      `All ${merge.conflicts.length} conflict(s) resolved. Finalize the merge of ${merge.otherRef} into ${merge.baseRef}?`,
      'Finalize', 'Not yet',
    );
    if (go !== 'Finalize') return;
    const message = await vscode.window.showInputBox({
      title: 'Merge commit message',
      value: `Merge ${merge.otherRef} into ${merge.baseRef}`,
      validateInput: (s) => s.trim() ? undefined : 'A commit message is required',
    });
    if (!message) return;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: 'Diversion: finalizing merge' },
        () => repo.finalizeMerge(merge.id, message.trim()),
      );
      void vscode.window.showInformationMessage(`Merged ${merge.otherRef} into ${merge.baseRef}.`);
    } catch (err) {
      void vscode.window.showErrorMessage(`Diversion: finalize failed: ${(err as Error).message}`);
    }
  }

  /**
   * Scratch files keep the original extension so the editor picks the right
   * language, and sit in a per-merge directory that we clear on dispose.
   */
  private async writeScratch(
    mergeId: string,
    conflict: MergeConflict,
    text: string,
  ): Promise<vscode.Uri> {
    const dir = vscode.Uri.joinPath(this.storageUri, 'merges', safeSegment(mergeId));
    await fs.mkdir(dir.fsPath, { recursive: true });
    const base = path.basename(conflict.path) || 'conflict';
    const file = vscode.Uri.joinPath(dir, `${safeSegment(conflict.id)}-${base}`);
    await fs.writeFile(file.fsPath, text, 'utf8');
    return file;
  }

  dispose(): void {
    // Leave any file the user still has open; drop the rest.
    for (const p of this.pending.keys()) {
      void fs.rm(p, { force: true }).catch(() => undefined);
    }
    this.pending.clear();
  }
}

/** Keep IDs usable as a single path segment. */
function safeSegment(s: string): string {
  return s.replace(/[^\w.-]+/g, '_');
}
