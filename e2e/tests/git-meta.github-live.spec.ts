/**
 * Git Meta — live GitHub pipeline: GitHub webhook → silo (github-git-meta.normalizer +
 * git-meta.behaviour) → v2 sync → widget.
 *
 * Drives a real repository through the GitHub REST API and asserts what the widget shows. Every
 * step polls the widget (`expect.poll` / auto-retrying assertions with LONG timeout) because
 * webhook delivery + silo processing are asynchronous.
 *
 * Env (in addition to the git-meta.fixture ones):
 *   E2E_GITHUB_TOKEN – PAT with `repo` on the connected repository
 *   E2E_GITHUB_REPO  – "owner/name" of a repository the workspace's GitHub app is installed on
 *   E2E_GITHUB_BASE  – base branch to fork from / target PRs at (default "main")
 */

import { test, expect } from "../fixtures/git-meta.fixture";
import { uid } from "../utils/unique";

const LONG = 90_000;
const GH = "https://api.github.com";

const ghEnv = () => ({
  token: process.env.E2E_GITHUB_TOKEN,
  repo: process.env.E2E_GITHUB_REPO,
  base: process.env.E2E_GITHUB_BASE ?? "main",
});

type Ref = { object: { sha: string } };
type Commit = { sha: string; tree: { sha: string } };
type Pull = { number: number; html_url: string; head: { sha: string } };

/** Thin GitHub REST client — only what these journeys need. */
class GitHub {
  constructor(
    private readonly token: string,
    readonly repo: string
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${GH}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path} → ${response.status} ${await response.text()}`);
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  headSha(branch: string) {
    return this.call<Ref>("GET", `/repos/${this.repo}/git/ref/heads/${branch}`).then((r) => r.object.sha);
  }

  async createBranch(name: string, fromSha: string) {
    await this.call("POST", `/repos/${this.repo}/git/refs`, { ref: `refs/heads/${name}`, sha: fromSha });
  }

  async deleteBranch(name: string) {
    await this.call("DELETE", `/repos/${this.repo}/git/refs/heads/${name}`);
  }

  /** Creates a one-file commit on `branch` and returns its sha (this fires a `push` webhook). */
  async commit(branch: string, message: string, force = false): Promise<string> {
    const parent = await this.headSha(branch);
    const parentCommit = await this.call<Commit>("GET", `/repos/${this.repo}/git/commits/${parent}`);
    const blob = await this.call<{ sha: string }>("POST", `/repos/${this.repo}/git/blobs`, {
      content: `${message}\n${new Date().toISOString()}\n`,
      encoding: "utf-8",
    });
    const tree = await this.call<{ sha: string }>("POST", `/repos/${this.repo}/git/trees`, {
      base_tree: parentCommit.tree.sha,
      tree: [{ path: `e2e/${uid()}.txt`, mode: "100644", type: "blob", sha: blob.sha }],
    });
    const commit = await this.call<Commit>("POST", `/repos/${this.repo}/git/commits`, {
      message,
      tree: tree.sha,
      parents: force ? [] : [parent],
    });
    await this.call("PATCH", `/repos/${this.repo}/git/refs/heads/${branch}`, { sha: commit.sha, force });
    return commit.sha;
  }

  openPull(head: string, base: string, title: string, body = "", draft = false) {
    return this.call<Pull>("POST", `/repos/${this.repo}/pulls`, { head, base, title, body, draft });
  }

  updatePull(number: number, patch: { state?: "open" | "closed"; title?: string }) {
    return this.call<Pull>("PATCH", `/repos/${this.repo}/pulls/${number}`, patch);
  }

  mergePull(number: number) {
    return this.call("PUT", `/repos/${this.repo}/pulls/${number}/merge`, { merge_method: "squash" });
  }

  review(number: number, event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", body = "e2e review") {
    return this.call("POST", `/repos/${this.repo}/pulls/${number}/reviews`, { event, body });
  }
}

test.describe("Git Meta — live GitHub", { tag: ["@git-meta", "@live", "@generated"] }, () => {
  test.describe.configure({ mode: "serial", timeout: 6 * 60_000 });

  let gh: GitHub;
  const created: string[] = [];

  test.beforeAll(() => {
    const { token, repo } = ghEnv();
    test.skip(!(token && repo), "E2E_GITHUB_TOKEN / E2E_GITHUB_REPO not set");
    gh = new GitHub(token!, repo!);
  });

  test.afterAll(async () => {
    for (const b of created) await gh.deleteBranch(b).catch(() => undefined);
  });

  const newBranch = async (name: string) => {
    await gh.createBranch(name, await gh.headSha(ghEnv().base));
    created.push(name);
  };

  test("GL-01 branch named after the item + push: card, commit, actor appear", async ({ gitMeta, gitMetaTarget }) => {
    const item = await gitMetaTarget.createWorkItem();
    const branch = `${item.ref}-live-push`;
    await newBranch(branch);
    const sha = await gh.commit(branch, `${item.ref} first live commit`);

    await gitMeta.goto(item.url);
    await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.branchRepositoryLabel(branch, gh.repo)).toBeVisible();
    const row = gitMeta.commitRow(sha);
    await expect(row).toBeVisible({ timeout: LONG });
    await expect(row).toHaveAttribute("href", `https://github.com/${gh.repo}/commit/${sha}`);
  });

  test("GL-02 open → approve → merge PR lifecycle is reflected with status and review pills", async ({
    gitMeta,
    page,
    gitMetaTarget,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const branch = `${item.ref}-live-pr`;
    await newBranch(branch);
    await gh.commit(branch, `${item.ref} pr commit`);
    const pr = await gh.openPull(branch, ghEnv().base, `${item.ref} live pull request`);

    await gitMeta.goto(item.url);
    await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.pullRequestRow(pr.number)).toBeVisible({ timeout: LONG });
    await expect(gitMeta.pullRequestStatusPill(pr.number, "OPEN")).toBeVisible();
    await expect(gitMeta.pullRequestRow(pr.number)).toHaveAttribute("href", pr.html_url);
    await expect(gitMeta.pullRequestRow(pr.number)).toContainText(`${ghEnv().base} ← ${branch}`);

    // Approval → "Approved" review pill (status stays Open)
    await gh.review(pr.number, "APPROVE").catch(() => gh.review(pr.number, "COMMENT")); // self-approval is rejected on own PRs
    await page.reload();
    await gitMeta.expandIfCollapsed();
    await expect
      .poll(async () => (await gitMeta.pullRequestReviewPill(pr.number, "APPROVED").count()) > 0, { timeout: LONG })
      .toBeTruthy();

    // Merge → "Merged" pill, diff stats present
    await gh.mergePull(pr.number);
    await page.reload();
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.pullRequestStatusPill(pr.number, "MERGED")).toBeVisible({ timeout: LONG });
    await expect(gitMeta.pullRequestRow(pr.number)).toContainText(/\+\d+/);
  });

  test("GL-03 close then reopen PR flips Closed → Open", async ({ gitMeta, page, gitMetaTarget }) => {
    const item = await gitMetaTarget.createWorkItem();
    const branch = `${item.ref}-live-reopen`;
    await newBranch(branch);
    await gh.commit(branch, `${item.ref} reopen commit`);
    const pr = await gh.openPull(branch, ghEnv().base, `${item.ref} reopen me`);

    await gitMeta.goto(item.url);
    await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.pullRequestStatusPill(pr.number, "OPEN")).toBeVisible({ timeout: LONG });

    await gh.updatePull(pr.number, { state: "closed" });
    await page.reload();
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.pullRequestStatusPill(pr.number, "CLOSED")).toBeVisible({ timeout: LONG });

    await gh.updatePull(pr.number, { state: "open" });
    await page.reload();
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.pullRequestStatusPill(pr.number, "OPEN")).toBeVisible({ timeout: LONG });
  });

  test("GL-04 draft PR renders the Draft pill", async ({ gitMeta, gitMetaTarget }) => {
    const item = await gitMetaTarget.createWorkItem();
    const branch = `${item.ref}-live-draft`;
    await newBranch(branch);
    await gh.commit(branch, `${item.ref} draft commit`);
    const pr = await gh.openPull(branch, ghEnv().base, `${item.ref} draft`, "", true);

    await gitMeta.goto(item.url);
    await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.pullRequestStatusPill(pr.number, "DRAFT")).toBeVisible({ timeout: LONG });
  });

  test("GL-05 [#9730] PR title references the item while branch name does not → branch is linked, and stays linked after a later push", async ({
    gitMeta,
    page,
    gitMetaTarget,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const branch = `no-ref-${uid().toLowerCase()}`;
    await newBranch(branch);
    await gh.commit(branch, "plain commit, no reference");
    const pr = await gh.openPull(branch, ghEnv().base, `${item.ref} referenced only in the PR title`);

    await gitMeta.goto(item.url);
    await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
    await gitMeta.expandIfCollapsed();
    // Branch card exists (not a loose PR) and the PR sits inside it
    await expect(gitMeta.branchCard(branch)).toBeVisible({ timeout: LONG });
    await expect(
      gitMeta.branchCard(branch).getByRole("link", { name: new RegExp(`#${pr.number}\\b`) })
    ).toBeVisible();
    await expect(gitMeta.loosePullRequests()).toHaveCount(0);

    // Race flagged in #9730 review: a subsequent push (branch has no reference of its own) must NOT
    // drop the branch link. If it does, that is a defect — do not weaken this assertion.
    const sha = await gh.commit(branch, "follow-up push without reference");
    await page.reload();
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.branchCard(branch).getByRole("link", { name: new RegExp(sha.slice(0, 7)) })).toBeVisible({
      timeout: LONG,
    });
    await expect(gitMeta.branchCard(branch)).toBeVisible();
    await expect(gitMeta.loosePullRequests()).toHaveCount(0);
  });

  test("GL-06 force-push replaces the head without duplicating commits", async ({ gitMeta, page, gitMetaTarget }) => {
    const item = await gitMetaTarget.createWorkItem();
    const branch = `${item.ref}-live-force`;
    await newBranch(branch);
    const first = await gh.commit(branch, `${item.ref} to be rewritten`);

    await gitMeta.goto(item.url);
    await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.commitRow(first)).toBeVisible({ timeout: LONG });

    const rewritten = await gh.commit(branch, `${item.ref} rewritten`, true);
    await page.reload();
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.commitRow(rewritten)).toBeVisible({ timeout: LONG });
    const rows = gitMeta.branchCommitRows(branch);
    const shas = await rows.allInnerTexts();
    expect(new Set(shas.map((t) => t.slice(0, 7))).size).toBe(shas.length);
  });

  test("GL-07 deleting the branch keeps the card with a Deleted pill", async ({ gitMeta, page, gitMetaTarget }) => {
    const item = await gitMetaTarget.createWorkItem();
    const branch = `${item.ref}-live-delete`;
    await newBranch(branch);
    await gh.commit(branch, `${item.ref} before delete`);

    await gitMeta.goto(item.url);
    await expect(gitMeta.header()).toBeVisible({ timeout: LONG });

    await gh.deleteBranch(branch);
    created.splice(created.indexOf(branch), 1);
    await page.reload();
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.branchDeletedPill(branch)).toBeVisible({ timeout: LONG });
  });

  test("GL-08 commit to the base branch whose message names the item shows as a loose commit", async ({
    gitMeta,
    gitMetaTarget,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const sha = await gh.commit(ghEnv().base, `${item.ref} direct-to-${ghEnv().base} note`);

    await gitMeta.goto(item.url);
    await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.looseCommits()).toBeVisible({ timeout: LONG });
    await expect(gitMeta.commitRow(sha)).toBeVisible();
    await expect(gitMeta.branchCard(ghEnv().base)).toHaveCount(0);
  });

  test("GL-10 one PR and one commit referencing two work items appear on both items", async ({
    gitMeta,
    gitMetaTarget,
  }) => {
    const a = await gitMetaTarget.createWorkItem();
    const b = await gitMetaTarget.createWorkItem();
    const branch = `${a.ref}-${b.ref}-shared`;
    await newBranch(branch);
    const sha = await gh.commit(branch, `${a.ref} ${b.ref} shared commit`);
    const pr = await gh.openPull(branch, ghEnv().base, `${a.ref} ${b.ref} touches both items`);

    for (const item of [a, b]) {
      await gitMeta.goto(item.url);
      await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
      await gitMeta.expandIfCollapsed();
      await expect(gitMeta.branchCard(branch)).toBeVisible({ timeout: LONG });
      await expect(gitMeta.pullRequestRow(pr.number)).toBeVisible({ timeout: LONG });
      await expect(gitMeta.commitRow(sha)).toBeVisible();
      // Each item sees the shared branch exactly once — no duplicate card per reference
      await expect(gitMeta.branchCard(branch)).toHaveCount(1);
    }
  });

  test("GL-11 PR referencing two items: merging updates both; deleting the merged branch keeps both cards as Deleted", async ({
    gitMeta,
    gitMetaTarget,
  }) => {
    const a = await gitMetaTarget.createWorkItem();
    const b = await gitMetaTarget.createWorkItem();
    const branch = `${a.ref}-live-multi-merge`;
    await newBranch(branch);
    await gh.commit(branch, `${a.ref} multi merge commit`);
    const pr = await gh.openPull(branch, ghEnv().base, `${a.ref} ${b.ref} merge both`);

    for (const item of [a, b]) {
      await gitMeta.goto(item.url);
      await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
      await gitMeta.expandIfCollapsed();
      await expect(gitMeta.pullRequestStatusPill(pr.number, "OPEN")).toBeVisible({ timeout: LONG });
    }

    await gh.mergePull(pr.number);
    for (const item of [a, b]) {
      await gitMeta.goto(item.url);
      await gitMeta.expandIfCollapsed();
      await expect(gitMeta.pullRequestStatusPill(pr.number, "MERGED")).toBeVisible({ timeout: LONG });
    }

    await gh.deleteBranch(branch);
    created.splice(created.indexOf(branch), 1);
    for (const item of [a, b]) {
      await gitMeta.goto(item.url);
      await gitMeta.expandIfCollapsed();
      await expect(gitMeta.branchDeletedPill(branch)).toBeVisible({ timeout: LONG });
      // Merged PR and its commits survive the branch deletion
      await expect(gitMeta.pullRequestStatusPill(pr.number, "MERGED")).toBeVisible();
      await expect(gitMeta.branchCommitRows(branch).first()).toBeVisible();
    }
  });

  test("GL-12 closing a PR without merging, then deleting its branch: Closed pill + Deleted pill coexist", async ({
    gitMeta,
    page,
    gitMetaTarget,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const branch = `${item.ref}-live-close-delete`;
    await newBranch(branch);
    await gh.commit(branch, `${item.ref} abandoned work`);
    const pr = await gh.openPull(branch, ghEnv().base, `${item.ref} abandoned`);

    await gitMeta.goto(item.url);
    await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.pullRequestStatusPill(pr.number, "OPEN")).toBeVisible({ timeout: LONG });

    await gh.updatePull(pr.number, { state: "closed" });
    await gh.deleteBranch(branch);
    created.splice(created.indexOf(branch), 1);
    await page.reload();
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.pullRequestStatusPill(pr.number, "CLOSED")).toBeVisible({ timeout: LONG });
    await expect(gitMeta.branchDeletedPill(branch)).toBeVisible({ timeout: LONG });
    // A closed (not merged) PR must never be shown as Merged
    await expect(gitMeta.pullRequestStatusPill(pr.number, "MERGED")).toHaveCount(0);
  });

  test("GL-09 an unrelated push does not attach anything to the item", async ({ gitMeta, gitMetaTarget }) => {
    const item = await gitMetaTarget.createWorkItem();
    const control = await gitMetaTarget.createWorkItem();
    const branch = `unrelated-${uid().toLowerCase()}`;
    const controlBranch = `${control.ref}-live-control`;
    await newBranch(branch);
    await newBranch(controlBranch);
    await gh.commit(branch, "nothing to see here");
    await gh.commit(controlBranch, `${control.ref} control commit`);

    // The control item proves the pipeline has processed this batch of webhooks...
    await gitMeta.goto(control.url);
    await expect(gitMeta.header()).toBeVisible({ timeout: LONG });

    // ...so the unrelated item having no widget is a real negative, not a stale read.
    await gitMeta.goto(item.url);
    await expect(gitMeta.page.getByText(item.name, { exact: true }).first()).toBeVisible();
    await expect(gitMeta.header()).toHaveCount(0);
  });
});
