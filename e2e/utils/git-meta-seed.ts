/**
 * Deterministic Git Meta seeding through the v2 sync surface — the same endpoint silo calls after
 * normalizing a GitHub webhook (`POST /api/v2/workspaces/{slug}/git-meta/`, PR #9200).
 *
 * Why seed here instead of only through real GitHub webhooks: the widget has states (draft PR,
 * changes-requested review, force-push reconciliation, >5 and `has_more` commit pages, deleted
 * branch, loose commits) that are slow or impossible to produce on demand against a live repo, but
 * every one of them is a single, idempotent payload here. The live-GitHub journey lives in
 * `tests/git-meta.github-live.spec.ts` and covers the silo → v2 → widget pipe end to
 * end; this module lets the widget specs pin each rendered state precisely.
 *
 * Payload shape mirrors apps/api/plane/api_v2/serializers/git_meta.py (`GitMetaGraphWriteSerializer`).
 *
 * Required env (all read lazily so unrelated specs never fail on import):
 *   E2E_API_URL                      – API origin, e.g. https://silo.runway.plane.town
 *   E2E_GIT_META_TOKEN               – OAuth bearer token carrying the `git.meta` scope, issued to an
 *                                      app with IntegrationPermissions.CREATE on the workspace
 *   E2E_GIT_META_WORKSPACE_CONNECTION_ID – a GitHub WorkspaceConnection id in the target workspace
 */

import type { APIRequestContext } from "@playwright/test";
import { uid } from "./unique";
import { API_URL } from "../playwright.config";

export type GitProvider =
  | "GITHUB"
  | "GITHUB_ENTERPRISE"
  | "GITLAB"
  | "GITLAB_ENTERPRISE"
  | "BITBUCKET"
  | "BITBUCKET_DC";
export type GitBranchChange = "CREATED" | "UPDATED" | "FORCED" | "DELETED" | "REFERENCED";
export type GitPullRequestStatus = "DRAFT" | "OPEN" | "MERGED" | "CLOSED";
export type GitReviewState = "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | "APPROVED";

export type SeedActor = {
  provider: GitProvider;
  external_id: string;
  username?: string;
  display_name?: string;
  avatar_url?: string;
  profile_url?: string;
  email?: string | null;
  member_id?: string | null;
};

export type SeedLink = { issue_id: string; is_closing?: boolean };

export type SeedCommit = {
  sha: string;
  title?: string;
  url?: string;
  committed_at: string;
  actor?: SeedActor | null;
  links?: SeedLink[];
};

export type SeedPullRequest = {
  number: string;
  title: string;
  status: GitPullRequestStatus;
  review_state?: GitReviewState | null;
  opened_at: string;
  closed_at?: string | null;
  url?: string;
  target_branch: string;
  head_sha?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  actor?: SeedActor | null;
  commits?: SeedCommit[];
  links?: SeedLink[];
};

export type SeedBranch = {
  name: string;
  change: GitBranchChange;
  url?: string;
  head_sha?: string;
  actor?: SeedActor | null;
  commits?: SeedCommit[];
  pull_request?: SeedPullRequest | null;
  links?: SeedLink[];
};

export type SeedRepository = {
  workspace_connection_id: string;
  provider: GitProvider;
  external_id: string;
  name: string;
  full_name: string;
  url: string;
};

export type GitMetaSyncPayload = {
  event_at: string;
  repository: SeedRepository;
  actor?: SeedActor | null;
  branches: SeedBranch[];
};

/** Read-side shape — packages/types/src/issues/issue_git_meta.ts `TWorkItemGitMeta`. */
export type GitMetaRead = {
  branches: Array<{
    id: string;
    name: string;
    url: string | null;
    is_deleted: boolean;
    linked_by: string | null;
    repository: { provider: GitProvider; full_name: string; url: string };
    pull_request: null | {
      number: string;
      title: string;
      status: GitPullRequestStatus | null;
      review_state: GitReviewState | null;
      closed_at: string | null;
      additions: number | null;
      deletions: number | null;
      changed_files: number | null;
      linked_by: string | null;
    };
    commits: {
      total_count: number;
      has_more: boolean;
      results: Array<{ sha: string; title: string; url: string | null }>;
    };
  }>;
  pull_requests: Array<{ number: string; title: string; status: GitPullRequestStatus | null }>;
  commits: Array<{ sha: string; title: string }>;
};

export const gitMetaEnv = () => {
  const apiUrl = API_URL;
  const token = process.env.E2E_GIT_META_TOKEN;
  const connectionId = process.env.E2E_GIT_META_WORKSPACE_CONNECTION_ID;
  return { apiUrl, token, connectionId, configured: Boolean(token && connectionId) };
};

export const GITHUB_ACTOR: SeedActor = {
  provider: "GITHUB",
  external_id: "e2e-octocat",
  username: "e2e-octocat",
  display_name: "E2E Octocat",
  avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
  profile_url: "https://github.com/octocat",
};

const REPO_ORG = "acme-inc";

export const seedRepository = (connectionId: string | undefined, name = `e2e-repo-${uid()}`): SeedRepository => {
  if (!connectionId) throw new Error("E2E_GIT_META_WORKSPACE_CONNECTION_ID is required to seed a repository");
  return {
  workspace_connection_id: connectionId,
  provider: "GITHUB",
  external_id: `e2e-${name}`,
  name,
  full_name: `${REPO_ORG}/${name}`,
  url: `https://github.com/${REPO_ORG}/${name}`,
  };
};

export const branchUrl = (repo: SeedRepository, branch: string) => `${repo.url}/tree/${branch}`;
export const commitUrl = (repo: SeedRepository, sha: string) => `${repo.url}/commit/${sha}`;
export const pullRequestUrl = (repo: SeedRepository, number: string) => `${repo.url}/pull/${number}`;

/** A fake, well-formed 40-hex SHA whose first 7 chars are unique per call. */
export const fakeSha = (): string => {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 40; i++) out += hex[Math.floor(Math.random() * 16)];
  return out;
};

export const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

export const makeCommit = (
  repo: SeedRepository,
  title: string,
  ageMinutes: number,
  links: SeedLink[] = []
): SeedCommit => {
  const sha = fakeSha();
  return { sha, title, url: commitUrl(repo, sha), committed_at: minutesAgo(ageMinutes), actor: GITHUB_ACTOR, links };
};

export const makePullRequest = (
  repo: SeedRepository,
  overrides: Partial<SeedPullRequest> & { number: string; title: string }
): SeedPullRequest => ({
  status: "OPEN",
  opened_at: minutesAgo(120),
  target_branch: "preview",
  url: pullRequestUrl(repo, overrides.number),
  additions: 266,
  deletions: 18,
  changed_files: 12,
  actor: GITHUB_ACTOR,
  ...overrides,
});

export class GitMetaSeeder {
  constructor(
    private readonly request: APIRequestContext,
    private readonly workspaceSlug: string
  ) {}

  /** `POST /api/v2/workspaces/{slug}/git-meta/` — returns the raw response so specs can assert 4xx too. */
  async syncRaw(payload: GitMetaSyncPayload, token = gitMetaEnv().token) {
    return this.request.post(`${gitMetaEnv().apiUrl}/api/v2/workspaces/${this.workspaceSlug}/git-meta/`, {
      data: payload,
      headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
    });
  }

  async sync(payload: GitMetaSyncPayload): Promise<{ repository_id: string; branches: number }> {
    const response = await this.syncRaw(payload);
    if (!response.ok()) throw new Error(`git-meta sync failed: ${response.status()} ${await response.text()}`);
    return (await response.json()) as { repository_id: string; branches: number };
  }

  /** Convenience: one branch event. */
  async syncBranch(repo: SeedRepository, branch: SeedBranch, eventAt = new Date().toISOString()) {
    return this.sync({ event_at: eventAt, repository: repo, actor: GITHUB_ACTOR, branches: [branch] });
  }

  /**
   * Internal read endpoint the widget itself calls (session-cookie auth — the `request` context here
   * must be the browser-authenticated one). Returns null on 403/404, mirroring
   * `useWorkItemGitMeta`.
   */
  async read(projectId: string, workItemId: string): Promise<GitMetaRead | null> {
    const response = await this.request.get(
      `${gitMetaEnv().apiUrl}/api/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${workItemId}/git-meta/`
    );
    if (response.status() === 403 || response.status() === 404) return null;
    if (!response.ok()) throw new Error(`git-meta read failed: ${response.status()} ${await response.text()}`);
    return (await response.json()) as GitMetaRead;
  }
}
