/**
 * Git Meta — live GitLab Cloud / Bitbucket Cloud pipelines: provider webhook → silo
 * (<provider>-git-meta.normalizer + git-meta.behaviour) → v2 sync → widget.
 *
 * One parameterised journey set (GP-01..08) runs per provider. Mirrors the GitHub lane
 * (git-meta.github-live.spec.ts) minus GitHub-only flows; provider gaps (Bitbucket cannot reopen a
 * declined PR, neither exposes force-push over REST) are recorded as `untested`, never as passes.
 *
 * Env (in addition to the git-meta.fixture ones):
 *   E2E_GITLAB_TOKEN / E2E_GITLAB_PROJECT ("group/project") / E2E_GITLAB_BASE (default "main") / E2E_GITLAB_HOST
 *   E2E_BITBUCKET_APP_PASSWORD / E2E_BITBUCKET_USERNAME (omit for an API token) /
 *   E2E_BITBUCKET_REPO ("workspace/repo_slug") / E2E_BITBUCKET_BASE (default "main")
 */

import { test, expect } from "../fixtures/git-meta.fixture";
import { providerFromEnv, type GitProvider, type ProviderKind } from "../utils/git-providers";
import { uid } from "../utils/unique";

const LONG = 120_000;

const PROVIDERS: { kind: ProviderKind; label: string; code: string }[] = [
  { kind: "GITLAB", label: "GitLab", code: "GLB" },
  { kind: "BITBUCKET", label: "Bitbucket", code: "BB" },
];

for (const { kind, label, code } of PROVIDERS) {
  test.describe(`Git Meta — live ${label}`, { tag: ["@git-meta", "@live", `@${kind.toLowerCase()}`, "@generated"] }, () => {
    test.describe.configure({ mode: "serial", timeout: 8 * 60_000 });

    let git: GitProvider;
    const created: string[] = [];

    test.beforeAll(() => {
      const provider = providerFromEnv(kind);
      test.skip(!provider, `${label} credentials / repository not set`);
      git = provider!;
    });

    test.afterAll(async () => {
      for (const b of created) await git.deleteBranch(b).catch(() => undefined);
    });

    const newBranch = async (name: string) => {
      await git.createBranch(name, await git.headSha(git.base));
      created.push(name);
    };
    const forget = (branch: string) => created.splice(created.indexOf(branch), 1);

    test(`${code}-01 branch named after the item + push: card, commit, actor appear`, async ({ gitMeta, gitMetaTarget }) => {
      const item = await gitMetaTarget.createWorkItem();
      const branch = `${item.ref}-${kind.toLowerCase()}-push`;
      await newBranch(branch);
      const sha = await git.commit(branch, `${item.ref} first ${label} commit`);

      await gitMeta.goto(item.url);
      await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
      await gitMeta.expandIfCollapsed();
      await expect(gitMeta.branchRepositoryLabel(branch, git.repo)).toBeVisible();
      const row = gitMeta.commitRow(sha);
      await expect(row).toBeVisible({ timeout: LONG });
      await expect(row).toHaveAttribute("href", git.commitUrl(sha));
    });

    test(`${code}-02 open → merge lifecycle shows Open then Merged with diff stats`, async ({ gitMeta, gitMetaTarget }) => {
      const item = await gitMetaTarget.createWorkItem();
      const branch = `${item.ref}-${kind.toLowerCase()}-merge`;
      await newBranch(branch);
      await git.commit(branch, `${item.ref} merge commit`);
      const pr = await git.openPull(branch, `${item.ref} ${label} merge request`);

      await gitMeta.goto(item.url);
      await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
      await gitMeta.expandIfCollapsed();
      await expect(gitMeta.pullRequestRow(pr.number)).toBeVisible({ timeout: LONG });
      await expect(gitMeta.pullRequestStatusPill(pr.number, "OPEN")).toBeVisible();
      await expect(gitMeta.pullRequestRow(pr.number)).toHaveAttribute("href", pr.url);
      await expect(gitMeta.pullRequestRow(pr.number)).toContainText(`${git.base} ← ${branch}`);

      await git.mergePull(pr.number);
      await gitMeta.reloadUntilVisible(gitMeta.pullRequestStatusPill(pr.number, "MERGED"), { timeout: LONG });
      await expect(gitMeta.pullRequestRow(pr.number)).toContainText(/\+\d+/);
    });

    test(`${code}-03 close then reopen flips Closed → Open`, async ({ gitMeta, gitMetaTarget }) => {
      const item = await gitMetaTarget.createWorkItem();
      const branch = `${item.ref}-${kind.toLowerCase()}-reopen`;
      await newBranch(branch);
      await git.commit(branch, `${item.ref} reopen commit`);
      const pr = await git.openPull(branch, `${item.ref} reopen me`);

      await gitMeta.goto(item.url);
      await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
      await gitMeta.expandIfCollapsed();
      await expect(gitMeta.pullRequestStatusPill(pr.number, "OPEN")).toBeVisible({ timeout: LONG });

      await git.closePull(pr.number);
      await gitMeta.reloadUntilVisible(gitMeta.pullRequestStatusPill(pr.number, "CLOSED"), { timeout: LONG });

      if (!git.can.reopen) {
        test.info().annotations.push({ type: "untested", description: `${label} cannot reopen a closed request via REST` });
        return;
      }
      await git.reopenPull(pr.number);
      await gitMeta.reloadUntilVisible(gitMeta.pullRequestStatusPill(pr.number, "OPEN"), { timeout: LONG });
    });

    test(`${code}-04 draft request renders the Draft pill`, async ({ gitMeta, gitMetaTarget }) => {
      test.skip(!git.can.draft, `${label} has no draft requests`);
      const item = await gitMetaTarget.createWorkItem();
      const branch = `${item.ref}-${kind.toLowerCase()}-draft`;
      await newBranch(branch);
      await git.commit(branch, `${item.ref} draft commit`);
      const pr = await git.openPull(branch, `${item.ref} draft`, true);

      await gitMeta.goto(item.url);
      await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
      await gitMeta.expandIfCollapsed();
      await expect(gitMeta.pullRequestStatusPill(pr.number, "DRAFT")).toBeVisible({ timeout: LONG });
    });

    test(`${code}-05 [#9730] request title references the item while branch name does not → branch linked, still linked after a later push`, async ({
      gitMeta,
      gitMetaTarget,
    }) => {
      const item = await gitMetaTarget.createWorkItem();
      const branch = `no-ref-${kind.toLowerCase()}-${uid().toLowerCase()}`;
      await newBranch(branch);
      await git.commit(branch, "plain commit, no reference");
      const pr = await git.openPull(branch, `${item.ref} referenced only in the title`);

      await gitMeta.goto(item.url);
      await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
      await gitMeta.expandIfCollapsed();
      await expect(gitMeta.branchCard(branch)).toBeVisible({ timeout: LONG });
      await expect(gitMeta.branchCard(branch).getByRole("link", { name: new RegExp(`#${pr.number}\\b`) })).toBeVisible();
      await expect(gitMeta.loosePullRequests()).toHaveCount(0);

      const sha = await git.commit(branch, "follow-up push without reference");
      await gitMeta.reloadUntilVisible(gitMeta.branchCard(branch).getByRole("link", { name: new RegExp(sha.slice(0, 7)) }), {
        timeout: LONG,
      });
      await expect(gitMeta.branchCard(branch)).toBeVisible();
      await expect(gitMeta.loosePullRequests()).toHaveCount(0);
    });

    test(`${code}-06 deleting the branch keeps the card with a Deleted pill`, async ({ gitMeta, gitMetaTarget }) => {
      const item = await gitMetaTarget.createWorkItem();
      const branch = `${item.ref}-${kind.toLowerCase()}-delete`;
      await newBranch(branch);
      await git.commit(branch, `${item.ref} before delete`);

      await gitMeta.goto(item.url);
      await expect(gitMeta.header()).toBeVisible({ timeout: LONG });

      await git.deleteBranch(branch);
      forget(branch);
      await gitMeta.reloadUntilVisible(gitMeta.branchDeletedPill(branch), { timeout: LONG });
    });

    test(`${code}-07 one request and one commit referencing two work items appear on both items`, async ({
      gitMeta,
      gitMetaTarget,
    }) => {
      const a = await gitMetaTarget.createWorkItem();
      const b = await gitMetaTarget.createWorkItem();
      const branch = `${a.ref}-${b.ref}-${kind.toLowerCase()}-shared`;
      await newBranch(branch);
      const sha = await git.commit(branch, `${a.ref} ${b.ref} shared commit`);
      const pr = await git.openPull(branch, `${a.ref} ${b.ref} touches both items`);

      for (const item of [a, b]) {
        await gitMeta.goto(item.url);
        await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
        await gitMeta.expandIfCollapsed();
        await expect(gitMeta.branchCard(branch)).toBeVisible({ timeout: LONG });
        await expect(gitMeta.pullRequestRow(pr.number)).toBeVisible({ timeout: LONG });
        await expect(gitMeta.commitRow(sha)).toBeVisible();
        await expect(gitMeta.branchCard(branch)).toHaveCount(1);
      }
    });

    test(`${code}-08 closing without merging, then deleting the branch: Closed + Deleted coexist, never Merged`, async ({
      gitMeta,
      gitMetaTarget,
    }) => {
      const item = await gitMetaTarget.createWorkItem();
      const branch = `${item.ref}-${kind.toLowerCase()}-close-delete`;
      await newBranch(branch);
      await git.commit(branch, `${item.ref} abandoned work`);
      const pr = await git.openPull(branch, `${item.ref} abandoned`);

      await gitMeta.goto(item.url);
      await expect(gitMeta.header()).toBeVisible({ timeout: LONG });
      await gitMeta.expandIfCollapsed();
      await expect(gitMeta.pullRequestStatusPill(pr.number, "OPEN")).toBeVisible({ timeout: LONG });

      await git.closePull(pr.number);
      await git.deleteBranch(branch);
      forget(branch);
      await gitMeta.reloadUntilVisible(gitMeta.pullRequestStatusPill(pr.number, "CLOSED"), { timeout: LONG });
      await gitMeta.reloadUntilVisible(gitMeta.branchDeletedPill(branch), { timeout: LONG });
      await expect(gitMeta.pullRequestStatusPill(pr.number, "MERGED")).toHaveCount(0);
    });
  });
}
