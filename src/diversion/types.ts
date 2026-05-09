export interface DaemonHealth {
  Version: string;
}

export interface DaemonWorkspace {
  WorkspaceID: string;
  RepoID: string;
  Path: string;
  AccountID: string;
  BranchID: string;
  BranchName: string;
  CommitID: string;
  Paused: boolean;
  ShouldDownload: boolean;
  RepoName: string;
  ReadOnly: boolean;
  DigestMethod: string;
  OrganizationTier: string;
}

export type DaemonWorkspaces = Record<string, DaemonWorkspace>;

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed';

export interface FileChange {
  kind: ChangeKind;
  path: string;
  /** Original path for renames. */
  fromPath?: string;
}

export interface RepoIdentity {
  workspaceId: string;
  workspacePath: string;
  repoId: string;
  repoName: string;
  branchId: string;
  branchName: string;
  commitId: string;
  paused: boolean;
  readOnly: boolean;
  /** From the daemon's workspace registry: INDIE / Studio / Enterprise. */
  tier: string;
}

// ─── AgentAPI wire types ──────────────────────────────────────────────
// Mirrors the schemas in the official AgentAPI OpenAPI spec
// (`/repo/{R}/workspace/{W}/sync`, `/sync/progress`, `/files/status`).
// We use Pascal-case field names as-is so the JSON parses without a
// remap layer; consumers get a plain TypeScript object back.

export interface ProgressStatus {
  TotalBytes: number;
  ExpectedTotalBytes: number;
}

export interface FileStatusAggregation {
  ItemsCount: number;
  ProgressStatus: ProgressStatus;
}

/**
 * Coarse "is the workspace caught up?" indicator from the agent. The
 * daemon's own /workspaces registry has a `Paused` flag but no
 * "currently syncing" signal — this endpoint is the only way to tell
 * "in progress" from "complete" without falling back to text parsing
 * `dv status`.
 */
export interface WorkspaceSyncStatus {
  IsSyncComplete: boolean;
  IsPaused?: boolean;
}

/**
 * Detailed sync activity from the agent — bytes transferred, queue
 * sizes, current action, blob-transfer state. Intended for live
 * progress UI while a sync is in flight.
 */
export interface WorkspaceSyncProgress {
  WorkspaceID: string;
  FileStats: {
    Inbound?: FileStatusAggregation;
    Outbound?: FileStatusAggregation;
  };
  LocalEventQueueSize?: number;
  CurrentSyncAction?: string;
  LastErr?: string;
  EnableLockRelease?: boolean;
  ErrorPaths?: Array<{
    path?: string;
    ErrorCode?: number;
    ErrorString?: string;
  }>;
  BlobTransferStatus?: string;
  IsPaused?: boolean;
}

export interface FileSyncStatus {
  Path: string;
  IsSynced: boolean;
  StatusDescription?: string;
}
