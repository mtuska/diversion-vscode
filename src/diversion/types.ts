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

// ─── Domain types ─────────────────────────────────────────────────────
// These describe Diversion concepts (commits, branches, shelves, repos,
// working-tree status) independent of how we obtain them. Previously they
// lived next to the CLI text parsers; since v0.6 they're sourced from the
// CoreAPI, so they belong with the other domain types.

export interface CommitSummary {
  id: string;
  subject: string;
}

export interface CommitDetails {
  id: string;
  /** Branch labels associated with the commit (e.g. its parent branches). */
  refs: string[];
  /** Set for merge commits: the second+ parent. */
  merge?: { refName: string; commitId: string };
  authorName: string;
  authorEmail: string;
  /** ISO-8601 UTC timestamp. */
  date: string;
  /** Full commit message. */
  message: string;
}

export interface BranchInfo {
  name: string;
  id: string;
  /** Tip commit ID for this branch. */
  commitId: string;
}

export interface ShelfInfo {
  /** Display name. */
  name: string;
  /** Stable ID, e.g. `dv.shelf.<uuid>`. */
  id?: string;
  /** Creation date / source branch, formatted for display. */
  description?: string;
  /** Raw label preserved for fallback display. */
  raw: string;
}

/**
 * A merge that stalled on conflicts and is waiting for the user. This is a
 * *server-side* concept and is entirely distinct from the `.dv-conflict`
 * sidecar files we scan for on disk — those are sync conflicts (the agent
 * couldn't reconcile a local edit with an incoming change). Conflicting
 * merges are resolved per block in the Diversion app, not on the filesystem.
 */
export interface OpenMerge {
  /** `dv.merge.<uuid>` — the ID the resolution endpoints are keyed on. */
  id: string;
  /** Destination of the merge (branch or workspace ID). */
  baseRef: string;
  /** Source being merged in (branch or commit ID). */
  otherRef: string;
  /** Display name of whoever started the merge, when the API supplies one. */
  startedBy?: string;
}

/** Which version of a conflicting path won. */
export type ConflictSide = 'RESULT' | 'BASE' | 'OTHER';

/**
 * One conflicting path inside an open merge. `base` is the destination
 * branch's version ("current"), `other` the incoming one.
 */
export interface MergeConflict {
  id: string;
  resolved: boolean;
  resolvedSide?: ConflictSide;
  /** Display path. The two sides differ only for a rename conflict. */
  path: string;
  basePath: string;
  otherPath: string;
  /** Unix file mode, echoed back when submitting a resolution. */
  fileMode: number;
}

export interface DetailedOpenMerge extends OpenMerge {
  conflicts: MergeConflict[];
}

export interface RepoListEntry {
  name: string;
  /** Stable repo ID, e.g. `dv.repo.<uuid>`. */
  id: string;
  /** Local clone path if the repo is cloned on this machine. */
  localPath?: string;
  /** True if the repo is cloned to this machine. */
  cloned: boolean;
}

// ─── CoreAPI wire types ───────────────────────────────────────────────
// Snake_case fields mirror the CoreAPI JSON (https://api.diversion.dev/v0)
// exactly so responses deserialize without a remap layer.

export interface CoreToken {
  AccessToken: string;
  /** Expiry as a Unix timestamp in seconds. */
  ExpiresAt: number;
}

export interface CoreAuthor {
  id?: string;
  name?: string;
  full_name?: string;
  email?: string;
  image?: string;
}

/** One changed path inside a `get_status` / `compare` response. */
export interface CoreFileItem {
  path: string;
  prev_path: string | null;
  hash: string | null;
  prev_hash: string | null;
  /** 2=new, 3=modified, 4=deleted. */
  status: number;
  mode?: number;
  mtime?: string;
  blob?: unknown;
}

export interface CoreComparisonItem {
  base_item: CoreFileItem | null;
  other_item: CoreFileItem | null;
}

export interface CoreComparisonResponse {
  object?: string;
  items: CoreComparisonItem[];
  cascaded_changes_count?: number;
  has_restricted_files?: boolean;
}

export interface CoreCommit {
  commit_id: string;
  commit_message: string;
  created_ts: number;
  branch_id?: string;
  author?: CoreAuthor;
  parents?: string[];
  parent_branches?: Array<{ id: string; name: string }>;
}

export interface CoreBranch {
  branch_id: string;
  branch_name: string;
  commit_id: string;
  author?: CoreAuthor;
  branch_description?: string | null;
  is_deleted?: boolean;
  is_protected?: boolean;
}

export interface CoreMerge {
  id: string;
  repo_id: string;
  base_ref: string;
  other_ref: string;
  ancestor_commit?: string;
  user?: CoreAuthor;
}

/** One side (base / other / result) of a conflicting path in a merge. */
export interface CoreConflictIndex {
  conflict_index_id: ConflictSide;
  /** Unix file mode. Required when echoing a resolution back. */
  file_mode: number;
  path: string;
  prev_path?: string;
  type?: number;
  size?: number;
}

export interface CoreConflict {
  conflict_id: string;
  is_resolved: boolean;
  resolved_side?: ConflictSide;
  base: CoreConflictIndex;
  other: CoreConflictIndex;
  result?: CoreConflictIndex;
}

export interface CoreDetailedMerge extends CoreMerge {
  conflicts?: CoreConflict[];
}

export interface CoreShelf {
  id: string;
  name: string;
  created_timestamp: number;
  branch_id?: string;
}

export interface CoreRepo {
  repo_id: string;
  repo_name: string;
  description?: string;
  size_bytes?: number;
  access_mode?: string;
  organization_id?: string;
}

/** Generic `{ object, items[] }` list envelope used by most list endpoints. */
export interface CoreListEnvelope<T> {
  object?: string;
  items?: T[];
}

/** A single file's state in another user's workspace/branch (other_statuses). */
export interface CoreOtherFileStatus {
  workspace_id: string;
  commit_id?: string;
  branch_id?: string;
  branch_name?: string;
  status?: number;
  mtime?: number;
  author?: CoreAuthor;
}

export interface CoreOtherStatusEntry {
  path: string;
  file_statuses: CoreOtherFileStatus[];
}

export interface CoreOtherStatusesResponse {
  statuses: CoreOtherStatusEntry[];
}
