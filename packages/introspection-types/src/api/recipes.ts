import type { CursorParams, IsoDate, Uuid } from "./common.js";

export interface Recipe {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  repository_id: Uuid;
  name: string;
  slug: string;
  git_ref: string;
  git_commit_sha: string;
  /** The pinned commit's subject line. */
  git_commit_subject?: string | null;
  sub_path?: string | null;
  description?: string | null;
  /** MCP servers the recipe declares (`id`, `required`, `tools`). */
  mcp_servers?: Record<string, unknown>[] | null;
  /** The recipe's Cedar policies (`schema`, `policies`, `routes`). */
  policies?: Record<string, unknown> | null;
  /** The recipe check of the pinned commit. */
  validation?: RecipeValidation | null;
  /**
   * The agents this version defines, from `agents/<name>.yaml`, the default
   * first. Null until checked.
   */
  agents?: string[] | null;
  /** The issue providers this version declares. Null until checked. */
  issue_providers?: string[] | null;
  created_by_member_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
}

/** One finding of a recipe check. */
export interface RecipeValidationDiagnostic {
  code: string;
  /** `error` unless the check says otherwise. */
  severity?: string;
  /** The file the diagnostic is about. */
  path: string;
  span?: Record<string, unknown> | null;
  message: string;
  help?: string | null;
}

/** The recipe check of a recipe's commit. */
export interface RecipeValidation {
  /**
   * `pending`, `valid`, `invalid` or `failed` (the check could not run;
   * `error_message` says why).
   */
  status?: string;
  validator_name?: string | null;
  validator_version?: string | null;
  checked_at?: IsoDate | null;
  error_message?: string | null;
  diagnostics?: RecipeValidationDiagnostic[];
}

/**
 * `POST /v1/recipes`: pin a repository at a ref or commit. The pin is
 * immutable; pointing at other content is a new recipe.
 */
export interface RecipeCreateParams {
  /** Project slug or id. */
  project: string;
  repository_id?: Uuid;
  name?: string;
  description?: string | null;
  git_ref?: string;
  git_commit_sha?: string;
  sub_path?: string | null;
}

/** `PATCH /v1/recipes/{id}`: presentation only. */
export interface RecipeUpdateParams {
  name?: string;
  description?: string | null;
}

export interface RecipeListParams extends CursorParams {
  project?: string;
  repository_id?: Uuid;
  name?: string;
}

export type RepositoryProvider = "github" | "introspection";

/** A Git repository linked to a project — the source a recipe pins. */
export interface Repository {
  id: Uuid;
  project_id: Uuid;
  /** GitHub App installation reaching a `github` repository; null when hosted. */
  integration_id: Uuid | null;
  /** Credential-free Git transport URL. */
  url: string | null;
  name: string | null;
  /** `owner/repo` for GitHub, the hosted slug otherwise. */
  slug: string | null;
  provider: RepositoryProvider;
  default_branch: string;
  provisioning_status: string;
  seed_template: string | null;
  created_at: IsoDate;
  pushed_at: IsoDate | null;
  head_commit_sha: string | null;
  is_recipe_source: boolean;
}

export interface RepositoryListParams {
  /** Project id or slug. */
  project: string;
  /** Only the repository with this slug (`owner/repo` or the hosted slug). */
  slug?: string;
}

/**
 * `POST /v1/repositories` body for a repository hosted on the project's Data
 * Plane. Idempotent on `slug`: a repeat returns the live row. The hosted copy
 * exists once the first push lands.
 */
export interface HostedRepositoryCreateParams {
  /** `hosted` is accepted as an alias of `introspection`. */
  provider: "introspection" | "hosted";
  slug: string;
  /** Defaults to `main`. */
  default_branch?: string;
  /**
   * A template baked into the deployment's worker image, rendered to this
   * slug as the first commit. Omit for the deployment's default; `null` for
   * an empty repository.
   */
  seed_template?: string | null;
}

/** `POST /v1/repositories` body linking a GitHub repository. */
export interface GithubRepositoryCreateParams {
  /** Defaults to `github`. */
  provider?: "github";
  /** The GitHub integration that reaches the repository. */
  integration_id: Uuid;
  url: string;
  name: string;
}

export type RepositoryCreateParams =
  HostedRepositoryCreateParams | GithubRepositoryCreateParams;

/** `POST /v1/repositories/{id}/access-token` body. */
export interface RepositoryAccessTokenParams {
  /** Permissions the minted token should carry, such as `{ contents: "read" }`. */
  permissions?: Record<string, string>;
}

/** A short-lived repository access token, minted for a session's Runtime. */
export interface RepositoryAccessGrant {
  /** The integration provider that minted the token. */
  provider: string;
  token: string;
  expires_at: IsoDate;
  /** Canonical GitHub `owner/name`. */
  repository: string;
}

export interface RepositoryGetParams {
  /** Project id or slug. */
  project: string;
}

export type RepositoryEntryType = "file" | "dir" | "symlink" | "submodule";

/** One entry of a repository directory listing. */
export interface RepositoryEntry {
  name: string;
  path: string;
  type: RepositoryEntryType;
  size: number;
  sha: string;
}

/** One page of a directory listing, pinned to `commit_sha`. */
export interface RepositoryDirectory {
  type: "dir";
  path: string;
  commit_sha: string;
  records: RepositoryEntry[];
  count: number;
  /** Opaque cursor for the next page; null once exhausted. */
  next: string | null;
}

/** A file's contents at `commit_sha`. */
export interface RepositoryFile {
  type: "file";
  name: string;
  path: string;
  size: number;
  sha: string;
  commit_sha: string;
  encoding: "utf-8" | "base64";
  content: string;
  /** True when the server returned only a prefix of the file. */
  truncated: boolean;
}

export type RepositoryContent = RepositoryDirectory | RepositoryFile;

export interface RepositoryContentsParams {
  /** Directory path; empty or omitted for the repository root. */
  path?: string;
  /** Branch, tag, or commit; the default branch when omitted. */
  ref?: string;
  /** Page size. */
  limit?: number;
}

export interface RepositoryContentGetParams {
  ref?: string;
  /** Page size when `path` is a directory. */
  limit?: number;
  /** Cursor from a previous directory page's `next`. */
  cursor?: string;
}

/** The author or committer of a commit. */
export interface RepositoryCommitPerson {
  name: string;
  email: string | null;
  date: IsoDate | null;
}

/** One commit of a repository's history. */
export interface RepositoryCommit {
  sha: string;
  parents: string[];
  message: string;
  author: RepositoryCommitPerson;
  committer: RepositoryCommitPerson;
}

export type RepositoryCommitFileStatus =
  "added" | "removed" | "modified" | "renamed";

/** One file a commit changed. */
export interface RepositoryCommitFile {
  filename: string;
  status: RepositoryCommitFileStatus;
  additions: number;
  deletions: number;
  changes: number;
}

/** A commit with the files it changed and its diff. */
export interface RepositoryCommitDetail extends RepositoryCommit {
  files: RepositoryCommitFile[];
  /** The whole commit as a unified git diff. */
  patch: string;
}

/** One page of a repository's commit history. */
export interface RepositoryCommitPage {
  records: RepositoryCommit[];
  count: number;
  /** Commits across every page, when the server counted them. */
  total_count?: number | null;
  /** Opaque cursor for the next page; null once exhausted. */
  next: string | null;
}

export interface RepositoryCommitsParams {
  /** Branch, tag, or commit to walk back from; the default branch when omitted. */
  sha?: string;
  /** Only commits touching this path. */
  path?: string;
  /** Page size, at most 100. */
  limit?: number;
}

/** Body of `repositories.merge()`, mirroring GitHub's merges API. */
export interface RepositoryMergeParams {
  /** Branch to merge into. */
  base: string;
  /** Branch name or full 40-character commit sha to merge. */
  head: string;
  /** Defaults server-side to `"Merge {head} into {base}"`. */
  commit_message?: string;
}

/** The merge commit a `repositories.merge()` created. */
export interface RepositoryMerge {
  sha: string;
  base: string;
  head: string;
  /** The sha `head` resolved to. */
  head_sha: string;
  parents: string[];
}

/** A branch of a repository, from `GET /v1/repositories/{id}/branches`. */
export interface RepositoryBranch {
  name: string;
  sha: string;
  committed_at: IsoDate | null;
}

export interface RepositoryBranchesParams {
  /** Only branches whose name contains this, ignoring case. */
  q?: string;
  limit?: number;
}
