/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Vendored from microsoft/vscode `src/vscode-dts/vscode.proposed.scmHistoryProvider.d.ts`.
// Tracking https://github.com/microsoft/vscode/issues/185269. Until this lands as a stable
// API, the extension manifest must declare `"enabledApiProposals": ["scmHistoryProvider"]`
// AND end users must run VS Code with `--enable-proposed-api mtuska.diversion-vscode`
// (or use VS Code Insiders) for the SCM Graph view to populate.

declare module 'vscode' {
	export interface SourceControl {
		historyProvider?: SourceControlHistoryProvider;
	}

	export interface SourceControlHistoryProvider {
		readonly currentHistoryItemRef: SourceControlHistoryItemRef | undefined;
		readonly currentHistoryItemRemoteRef: SourceControlHistoryItemRef | undefined;
		readonly currentHistoryItemBaseRef: SourceControlHistoryItemRef | undefined;

		readonly onDidChangeCurrentHistoryItemRefs: Event<void>;

		readonly onDidChangeHistoryItemRefs: Event<SourceControlHistoryItemRefsChangeEvent>;

		provideHistoryItemRefs(historyItemRefs: string[] | undefined, token: CancellationToken): ProviderResult<SourceControlHistoryItemRef[]>;
		provideHistoryItems(options: SourceControlHistoryOptions, token: CancellationToken): ProviderResult<SourceControlHistoryItem[]>;
		provideHistoryItemChanges(historyItemId: string, historyItemParentId: string | undefined, token: CancellationToken): ProviderResult<SourceControlHistoryItemChange[]>;

		resolveHistoryItem?(historyItemId: string, token: CancellationToken): ProviderResult<SourceControlHistoryItem>;
		resolveHistoryItemChatContext?(historyItemId: string, token: CancellationToken): ProviderResult<string>;
		resolveHistoryItemChangeRangeChatContext?(historyItemId: string, historyItemParentId: string, path: string, token: CancellationToken): ProviderResult<string>;
		resolveHistoryItemRefsCommonAncestor?(historyItemRefs: string[], token: CancellationToken): ProviderResult<string>;
	}

	export interface SourceControlHistoryOptions {
		readonly skip?: number;
		readonly limit?: number | { id?: string };
		readonly historyItemRefs?: readonly string[];
		readonly filterText?: string;
	}

	export interface SourceControlHistoryItemStatistics {
		readonly files: number;
		readonly insertions: number;
		readonly deletions: number;
	}

	export interface SourceControlHistoryItem {
		readonly id: string;
		readonly parentIds: string[];
		readonly subject: string;
		readonly message: string;
		readonly displayId?: string;
		readonly author?: string;
		readonly authorEmail?: string;
		readonly authorIcon?: IconPath;
		readonly timestamp?: number;
		readonly statistics?: SourceControlHistoryItemStatistics;
		readonly references?: SourceControlHistoryItemRef[];
		readonly tooltip?: MarkdownString | Array<MarkdownString> | undefined;
	}

	export interface SourceControlHistoryItemRef {
		readonly id: string;
		readonly name: string;
		readonly description?: string;
		readonly revision?: string;
		readonly category?: string;
		readonly icon?: IconPath;
	}

	export interface SourceControlHistoryItemChange {
		readonly uri: Uri;
		readonly originalUri: Uri | undefined;
		readonly modifiedUri: Uri | undefined;
	}

	export interface SourceControlHistoryItemRefsChangeEvent {
		readonly added: readonly SourceControlHistoryItemRef[];
		readonly removed: readonly SourceControlHistoryItemRef[];
		readonly modified: readonly SourceControlHistoryItemRef[];

		readonly silent: boolean;
	}
}
