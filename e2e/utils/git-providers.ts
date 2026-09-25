/**
 * Minimal REST clients for the providers the live Git Meta lanes drive. Each exposes the same
 * surface so one parameterised spec can run against GitLab Cloud and Bitbucket Cloud; the GitHub
 * lane keeps its own client (it predates this file and exercises GitHub-only flows).
 */

import { uid } from "./unique";

export type ProviderKind = "GITLAB" | "BITBUCKET";

export type PullRequest = { number: number; url: string };

export interface GitProvider {
  readonly kind: ProviderKind;
  /** `group/project` (GitLab) or `workspace/repo_slug` (Bitbucket) — what the widget prints. */
  readonly repo: string;
  readonly base: string;
  /** Capabilities that differ between providers; the spec skips the step when absent. */
  readonly can: { reopen: boolean; draft: boolean; forcePush: boolean };
  headSha(branch: string): Promise<string>;
  createBranch(name: string, fromSha: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  commit(branch: string, message: string): Promise<string>;
  commitUrl(sha: string): string;
  openPull(head: string, title: string, draft?: boolean): Promise<PullRequest>;
  closePull(number: number): Promise<void>;
  reopenPull(number: number): Promise<void>;
  mergePull(number: number): Promise<void>;
}

async function rest<T>(url: string, init: RequestInit & { label: string }): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${init.label} ${init.method ?? "GET"} ${url} → ${response.status} ${await response.text()}`);
  if (response.status === 204 || response.headers.get("content-length") === "0") return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/* ───────────────────────────── GitLab Cloud ───────────────────────────── */

type GlBranch = { commit: { id: string } };
type GlMr = { iid: number; web_url: string; state: string };

export class GitLab implements GitProvider {
  readonly kind = "GITLAB" as const;
  readonly can = { reopen: true, draft: true, forcePush: false };
  private readonly api: string;
  private readonly encoded: string;

  constructor(
    private readonly token: string,
    readonly repo: string,
    readonly base: string,
    private readonly host = "https://gitlab.com"
  ) {
    this.api = `${host}/api/v4`;
    this.encoded = encodeURIComponent(repo);
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return rest<T>(`${this.api}/projects/${this.encoded}${path}`, {
      label: "GitLab",
      method,
      headers: { "PRIVATE-TOKEN": this.token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  headSha(branch: string) {
    return this.call<GlBranch>("GET", `/repository/branches/${encodeURIComponent(branch)}`).then((b) => b.commit.id);
  }

  async createBranch(name: string, fromSha: string) {
    await this.call("POST", `/repository/branches?branch=${encodeURIComponent(name)}&ref=${fromSha}`);
  }

  async deleteBranch(name: string) {
    await this.call("DELETE", `/repository/branches/${encodeURIComponent(name)}`);
  }

  async commit(branch: string, message: string) {
    const created = await this.call<{ id: string }>("POST", "/repository/commits", {
      branch,
      commit_message: message,
      actions: [{ action: "create", file_path: `e2e/${uid()}.txt`, content: `${message}\n${new Date().toISOString()}\n` }],
    });
    return created.id;
  }

  commitUrl(sha: string) {
    return `${this.host}/${this.repo}/-/commit/${sha}`;
  }

  async openPull(head: string, title: string, draft = false) {
    const mr = await this.call<GlMr>("POST", "/merge_requests", {
      source_branch: head,
      target_branch: this.base,
      title: draft ? `Draft: ${title}` : title,
      remove_source_branch: false,
    });
    return { number: mr.iid, url: mr.web_url };
  }

  async closePull(number: number) {
    await this.call("PUT", `/merge_requests/${number}`, { state_event: "close" });
  }

  async reopenPull(number: number) {
    await this.call("PUT", `/merge_requests/${number}`, { state_event: "reopen" });
  }

  async mergePull(number: number) {
    // GitLab needs a moment after MR creation before it reports the MR as mergeable.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.call("PUT", `/merge_requests/${number}/merge`, { should_remove_source_branch: false });
        return;
      } catch (error) {
        if (attempt >= 10 || !/→ 4(05|22)/.test((error as Error).message)) throw error;
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  }
}

/* ─────────────────────────── Bitbucket Cloud ─────────────────────────── */

type BbBranch = { target: { hash: string } };
type BbPr = { id: number; links: { html: { href: string } } };

export class Bitbucket implements GitProvider {
  readonly kind = "BITBUCKET" as const;
  // Declined PRs cannot be reopened through the REST API; force-push is not exposed either.
  readonly can = { reopen: false, draft: true, forcePush: false };
  private readonly api = "https://api.bitbucket.org/2.0";
  private readonly auth: string;

  constructor(
    credential: { username?: string; secret: string },
    readonly repo: string,
    readonly base: string
  ) {
    // An app password authenticates with Basic <username:password>; an API token is a bearer.
    this.auth = credential.username
      ? `Basic ${Buffer.from(`${credential.username}:${credential.secret}`).toString("base64")}`
      : `Bearer ${credential.secret}`;
  }

  private call<T>(method: string, path: string, body?: unknown, form?: URLSearchParams): Promise<T> {
    return rest<T>(`${this.api}/repositories/${this.repo}${path}`, {
      label: "Bitbucket",
      method,
      headers: {
        Authorization: this.auth,
        ...(form ? {} : { "Content-Type": "application/json" }),
      },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  }

  headSha(branch: string) {
    return this.call<BbBranch>("GET", `/refs/branches/${encodeURIComponent(branch)}`).then((b) => b.target.hash);
  }

  async createBranch(name: string, fromSha: string) {
    await this.call("POST", "/refs/branches", { name, target: { hash: fromSha } });
  }

  async deleteBranch(name: string) {
    await this.call("DELETE", `/refs/branches/${encodeURIComponent(name)}`);
  }

  async commit(branch: string, message: string) {
    const form = new URLSearchParams();
    form.set("branch", branch);
    form.set("message", message);
    form.set(`e2e/${uid()}.txt`, `${message}\n${new Date().toISOString()}\n`);
    await this.call("POST", "/src", undefined, form);
    return this.headSha(branch);
  }

  commitUrl(sha: string) {
    return `https://bitbucket.org/${this.repo}/commits/${sha}`;
  }

  async openPull(head: string, title: string, draft = false) {
    const pr = await this.call<BbPr>("POST", "/pullrequests", {
      title,
      draft,
      source: { branch: { name: head } },
      destination: { branch: { name: this.base } },
      close_source_branch: false,
    });
    return { number: pr.id, url: pr.links.html.href };
  }

  async closePull(number: number) {
    // Bitbucket rejects a JSON POST with no body (400); an empty object is required.
    await this.call("POST", `/pullrequests/${number}/decline`, {});
  }

  async reopenPull(): Promise<void> {
    throw new Error("Bitbucket Cloud has no REST endpoint to reopen a declined pull request");
  }

  async mergePull(number: number) {
    await this.call("POST", `/pullrequests/${number}/merge`, { merge_strategy: "squash", close_source_branch: false });
  }
}

/* ───────────────────────────── Env wiring ───────────────────────────── */

export function providerFromEnv(kind: ProviderKind): GitProvider | undefined {
  if (kind === "GITLAB") {
    const { E2E_GITLAB_TOKEN: token, E2E_GITLAB_PROJECT: repo, E2E_GITLAB_BASE: base, E2E_GITLAB_HOST: host } = process.env;
    return token && repo ? new GitLab(token, repo, base ?? "main", host) : undefined;
  }
  const {
    E2E_BITBUCKET_APP_PASSWORD: secret,
    E2E_BITBUCKET_USERNAME: username,
    E2E_BITBUCKET_REPO: repo,
    E2E_BITBUCKET_BASE: base,
  } = process.env;
  return secret && repo ? new Bitbucket({ username, secret }, repo, base ?? "main") : undefined;
}
