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
}
