import { test, expect } from "../fixtures/git-meta.fixture";

/**
 * Read-only smoke against pre-existing Git Meta data on the target instance (no seeding, no
 * GitHub mutations). Defaults describe GITMETAQA-21 on silo.runway; override via E2E_SMOKE_*.
 */
const SMOKE = {
  workItemId: process.env.E2E_SMOKE_WORK_ITEM_ID ?? "7811fda7-24b2-4a01-bf62-4c29d6022822",
  headerCount: process.env.E2E_SMOKE_HEADER_COUNT ?? "7",
  repo: process.env.E2E_SMOKE_REPO ?? "Spvora/voralab",
  branch: process.env.E2E_SMOKE_BRANCH ?? "xyz",
  pr: Number(process.env.E2E_SMOKE_PR ?? 16),
  prDirection: process.env.E2E_SMOKE_PR_DIRECTION ?? "main ← xyz",
  branchCommits: Number(process.env.E2E_SMOKE_BRANCH_COMMITS ?? 3),
  commitSha: process.env.E2E_SMOKE_COMMIT_SHA ?? "5f014a8",
  longBranch: process.env.E2E_SMOKE_LONG_BRANCH ?? "commit_in_new_branch",
  longBranchCommits: Number(process.env.E2E_SMOKE_LONG_BRANCH_COMMITS ?? 14),
  mergedBranch: process.env.E2E_SMOKE_MERGED_BRANCH ?? "subhamprasad790-hub-patch-5",
  mergedPr: Number(process.env.E2E_SMOKE_MERGED_PR ?? 15),
};

test.describe("Git Meta smoke @smoke @widget @generated", () => {
  test("GS-01 existing work item renders branches, PR, commits, show more/less, collapse", async ({
    gitMeta,
    gitMetaTarget,
    api,
  }) => {
    await gitMeta.goto(api.workItemUrl(gitMetaTarget.workspaceSlug, gitMetaTarget.projectId, SMOKE.workItemId));
    await expect(gitMeta.header()).toBeVisible({ timeout: 20_000 });
    await expect(gitMeta.headerCount()).toHaveText(SMOKE.headerCount);
    await gitMeta.expandIfCollapsed();

    await expect(gitMeta.branchCard(SMOKE.branch)).toHaveCount(1);
    await expect(gitMeta.branchRepositoryLabel(SMOKE.branch, SMOKE.repo)).toBeVisible();
    await gitMeta.expandBranchIfCollapsed(SMOKE.branch);
    await expect(gitMeta.pullRequestRow(SMOKE.pr)).toBeVisible();
    await expect(gitMeta.pullRequestStatusPill(SMOKE.pr, "OPEN")).toBeVisible();
    await expect(gitMeta.pullRequestRow(SMOKE.pr)).toContainText(SMOKE.prDirection);
    await expect(gitMeta.pullRequestRow(SMOKE.pr)).toHaveAttribute(
      "href",
      `https://github.com/${SMOKE.repo}/pull/${SMOKE.pr}`
    );
    await expect(gitMeta.branchCommitRows(SMOKE.branch)).toHaveCount(SMOKE.branchCommits);
    await expect(gitMeta.commitRow(SMOKE.commitSha)).toBeVisible();
    await expect(gitMeta.looseCommits()).toHaveCount(1);
    await expect(gitMeta.loosePullRequests()).toHaveCount(0);

    await gitMeta.expandBranchIfCollapsed(SMOKE.longBranch);
    await expect(gitMeta.branchCommitRows(SMOKE.longBranch)).toHaveCount(5);
    await gitMeta.showMoreButton(SMOKE.longBranch).click();
    await expect(gitMeta.branchCommitRows(SMOKE.longBranch)).toHaveCount(SMOKE.longBranchCommits);
    await gitMeta.showLessButton(SMOKE.longBranch).click();
    await expect(gitMeta.branchCommitRows(SMOKE.longBranch)).toHaveCount(5);

    await expect(gitMeta.pullRequestStatusPill(SMOKE.mergedPr, "MERGED")).toHaveCount(0);
    await gitMeta.expandBranchIfCollapsed(SMOKE.mergedBranch);
    await expect(gitMeta.pullRequestStatusPill(SMOKE.mergedPr, "MERGED")).toBeVisible();

    await gitMeta.collapse();
    await expect(gitMeta.branchCard(SMOKE.branch)).toHaveCount(0);
  });
});
