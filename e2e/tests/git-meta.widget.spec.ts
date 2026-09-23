/**
 * Git Meta — "Development" widget on work-item detail (PR #9200, #9730).
 *
 * Each test seeds one deterministic graph through the v2 sync endpoint (what silo posts after a
 * webhook) and asserts the rendered state against the Figma "Git meta" section
 * (QIFFN1CB4ctxEkLIg8hXjY, node 4609-60946) frames:
 *   - git meta - with PR and commits          → GM-02/03/04
 *   - git meta - without PR                   → GM-05
 *   - git meta - with multiple commits        → GM-06/07 (Show more / Show less, >5 commits)
 *   - git meta - with merged / closed / draft → GM-08
 *   - git meta - when branch is deleted       → GM-10
 *
 * Run: cp .env.example .env (fill E2E_PLANE_* + E2E_GIT_META_TOKEN) && npx playwright test tests/git-meta.widget.spec.ts
 */

import { test, expect, requireSeedEnv } from "../fixtures/git-meta.fixture";
import {
  GITHUB_ACTOR,
  branchUrl,
  makeCommit,
  makePullRequest,
  minutesAgo,
  seedRepository,
} from "../utils/git-meta-seed";
import type { SeedBranch } from "../utils/git-meta-seed";

test.describe("Git Meta widget", { tag: ["@git-meta", "@widget", "@generated"] }, () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(({}, testInfo) => {
    if (!testInfo.title.startsWith("GM-01")) requireSeedEnv(testInfo);
  });

  test("GM-01 a work item with no git activity shows no Development section", async ({ gitMeta, gitMetaTarget }) => {
    const item = await gitMetaTarget.createWorkItem();
    await gitMeta.goto(item.url);
    await expect(gitMeta.page.getByText(item.name, { exact: true }).first()).toBeVisible();
    await expect(gitMeta.header()).toHaveCount(0);
  });

  test("GM-02 branch with PR and commits renders the full tree (Figma: with PR and commits)", async ({
    gitMeta,
    gitMetaTarget,
    seeder,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `feat/${item.ref.toLowerCase()}-acme-dashboard`;
    const c1 = makeCommit(repo, "Add page view aggregation worker", 120);
    const c2 = makeCommit(repo, "Wire analytics panel to work item detail", 60);
    const pr = makePullRequest(repo, { number: "6112", title: `${item.ref} Wiki page analytics`, head_sha: c2.sha });

    await seeder.syncBranch(repo, {
      name: branchName,
      change: "CREATED",
      url: branchUrl(repo, branchName),
      head_sha: c2.sha,
      commits: [c1, c2],
      pull_request: pr,
      links: [{ issue_id: item.id }],
    });

    await gitMeta.goto(item.url);

    // Section header: title + aggregate count (1 branch, nothing loose)
    await expect(gitMeta.header()).toBeVisible();
    await expect(gitMeta.headerCount()).toHaveText("1");
    await gitMeta.expandIfCollapsed();

    // Branch card header: provider icon, "org /", branch name, summary "1 pull request • 2 commits"
    const card = gitMeta.branchCard(branchName);
    await expect(gitMeta.branchRepositoryLabel(branchName, repo.full_name)).toBeVisible();
    await expect(card.getByText("1 pull request")).toBeVisible();
    await expect(card.getByText("2 commits")).toBeVisible();

    // Single branch → open by default; sub-sections labelled
    await expect(card.getByText("Pull request", { exact: true })).toBeVisible();
    await expect(card.getByText("Commits", { exact: true })).toBeVisible();

    // PR row: #number, title, Open pill, direction "preview ← <branch>", +266 -18, 12 files, actor
    const prRow = gitMeta.pullRequestRow("6112");
    await expect(prRow).toContainText(`${item.ref} Wiki page analytics`);
    await expect(gitMeta.pullRequestStatusPill("6112", "OPEN")).toBeVisible();
    await expect(prRow).toContainText(`preview ← ${branchName}`);
    await expect(gitMeta.pullRequestDiffStat("6112", "+266")).toBeVisible();
    await expect(gitMeta.pullRequestDiffStat("6112", "-18")).toBeVisible();
    await expect(prRow).toContainText("12");
    await expect(gitMeta.rowActor(prRow, GITHUB_ACTOR.display_name!)).toBeVisible();

    // Commit rows: 7-char sha + title, newest first, with relative time
    const rows = gitMeta.branchCommitRows(branchName);
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(c2.sha.slice(0, 7));
    await expect(rows.first()).toContainText("Wire analytics panel to work item detail");
    await expect(rows.last()).toContainText(c1.sha.slice(0, 7));
    await expect(rows.first()).toContainText(/ago|now|minute|hour/i);
  });

  test("GM-03 commit and PR rows are whole-row external links opening the provider URL in a new tab", async ({
    gitMeta,
    page,
    gitMetaTarget,
    seeder,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `fix/${item.ref.toLowerCase()}-links`;
    const commit = makeCommit(repo, "Link rows", 10);
    const pr = makePullRequest(repo, { number: "42", title: `${item.ref} link rows` });
    await seeder.syncBranch(repo, {
      name: branchName,
      change: "CREATED",
      url: branchUrl(repo, branchName),
      commits: [commit],
      pull_request: pr,
      links: [{ issue_id: item.id }],
    });

    await gitMeta.goto(item.url);
    await gitMeta.expandIfCollapsed();

    const commitRow = gitMeta.commitRow(commit.sha);
    await expect(commitRow).toHaveAttribute("href", commit.url!);
    await expect(commitRow).toHaveAttribute("target", "_blank");
    await expect(commitRow).toHaveAttribute("rel", /noreferrer/);

    const prRow = gitMeta.pullRequestRow("42");
    await expect(prRow).toHaveAttribute("href", pr.url!);
    await expect(prRow).toHaveAttribute("target", "_blank");

    // Clicking the row's trailing whitespace (not the sha/title text) still navigates → whole row is the link
    const box = (await commitRow.boundingBox())!;
    const popupPromise = page.context().waitForEvent("page");
    await commitRow.click({ position: { x: box.width * 0.6, y: box.height / 2 } });
    const popup = await popupPromise;
    expect(popup.url()).toBe(commit.url);
    await popup.close();
  });

  test("GM-04 branch card collapses and re-expands; Development section toggles", async ({
    gitMeta,
    gitMetaTarget,
    seeder,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `feat/${item.ref.toLowerCase()}-toggle`;
    const commit = makeCommit(repo, "Toggle me", 5);
    await seeder.syncBranch(repo, {
      name: branchName,
      change: "CREATED",
      url: branchUrl(repo, branchName),
      commits: [commit],
      links: [{ issue_id: item.id }],
    });

    await gitMeta.goto(item.url);
    await gitMeta.expandIfCollapsed();

    const row = gitMeta.commitRow(commit.sha);
    await expect(row).toBeVisible();
    await gitMeta.toggleBranch(branchName);
    await expect(row).toBeHidden();
    await expect(gitMeta.branchRepositoryLabel(branchName, repo.full_name)).toBeVisible(); // header stays
    await gitMeta.toggleBranch(branchName);
    await expect(row).toBeVisible();

    await gitMeta.collapse();
    await expect(gitMeta.branchCard(branchName)).toBeHidden();
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.branchCard(branchName)).toBeVisible();
  });

  test("GM-05 branch without a PR shows only the commit list (Figma: without PR)", async ({
    gitMeta,
    gitMetaTarget,
    seeder,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `chore/${item.ref.toLowerCase()}-no-pr`;
    await seeder.syncBranch(repo, {
      name: branchName,
      change: "CREATED",
      url: branchUrl(repo, branchName),
      commits: [makeCommit(repo, "One", 30), makeCommit(repo, "Two", 20)],
      links: [{ issue_id: item.id }],
    });

    await gitMeta.goto(item.url);
    await gitMeta.expandIfCollapsed();
    const card = gitMeta.branchCard(branchName);
    await expect(card.getByText("2 commits")).toBeVisible();
    await expect(card.getByText(/pull request/i)).toHaveCount(0);
    await expect(gitMeta.branchCommitRows(branchName)).toHaveCount(2);
  });

  test("GM-06 more than 5 commits: 5 inline, Show more reveals the rest, Show less collapses (Figma: multiple commits)", async ({
    gitMeta,
    gitMetaTarget,
    seeder,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `feat/${item.ref.toLowerCase()}-many`;
    const commits = Array.from({ length: 10 }, (_, i) => makeCommit(repo, `Commit ${10 - i}`, (i + 1) * 10));
    await seeder.syncBranch(repo, {
      name: branchName,
      change: "CREATED",
      url: branchUrl(repo, branchName),
      commits,
      pull_request: makePullRequest(repo, { number: "6112", title: "Wiki page analytics" }),
      links: [{ issue_id: item.id }],
    });

    await gitMeta.goto(item.url);
    await gitMeta.expandIfCollapsed();

    const card = gitMeta.branchCard(branchName);
    await expect(card.getByText("10 commits")).toBeVisible();
    await expect(gitMeta.branchCommitRows(branchName)).toHaveCount(5);
    await expect(gitMeta.showMoreButton(branchName)).toBeVisible();
    await expect(gitMeta.showLessButton(branchName)).toHaveCount(0);
    await expect(gitMeta.viewAllCommitsLink(branchName)).toHaveCount(0);

    await gitMeta.showMoreButton(branchName).click();
    await expect(gitMeta.branchCommitRows(branchName)).toHaveCount(10);
    await expect(gitMeta.showLessButton(branchName)).toBeVisible();
    await expect(gitMeta.showMoreButton(branchName)).toHaveCount(0);

    await gitMeta.showLessButton(branchName).click();
    await expect(gitMeta.branchCommitRows(branchName)).toHaveCount(5);
  });

  test("GM-07 commits beyond the server page expose 'View all commits' linking to the branch on GitHub @known-bug", async ({
    gitMeta,
    gitMetaTarget,
    seeder,
  }) => {
    // Observed on silo.runway: 60 seeded commits → "60 commits", 15 rendered after Show more,
    // but no "View all commits" link although has_more is true and branch.url is set.
    test.fixme();
    // COMMIT_PAGE_SIZE is server-side; seed comfortably past it so `has_more` is true.
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `feat/${item.ref.toLowerCase()}-paged`;
    const commits = Array.from({ length: 60 }, (_, i) => makeCommit(repo, `Paged commit ${60 - i}`, (i + 1) * 3));
    await seeder.syncBranch(repo, {
      name: branchName,
      change: "CREATED",
      url: branchUrl(repo, branchName),
      commits,
      links: [{ issue_id: item.id }],
    });

    const read = await seeder.read(gitMetaTarget.projectId, item.id);
    const branch = read?.branches.find((b) => b.name === branchName);
    test.skip(!branch?.commits.has_more, "Server page size ≥ 60 — raise the seeded count to exercise has_more");

    await gitMeta.goto(item.url);
    await gitMeta.expandIfCollapsed();
    await gitMeta.showMoreButton(branchName).click();

    const viewAll = gitMeta.viewAllCommitsLink(branchName);
    await expect(viewAll).toBeVisible();
    await expect(viewAll).toHaveAttribute("href", branchUrl(repo, branchName));
    await expect(viewAll).toHaveAttribute("target", "_blank");
    await expect(gitMeta.branchCard(branchName).getByText("60 commits")).toBeVisible();
  });

  for (const scenario of [
    { status: "MERGED", label: "Merged", figma: "with merged PR" },
    { status: "CLOSED", label: "Closed", figma: "with closed PR" },
    { status: "DRAFT", label: "Draft", figma: "with draft PR" },
  ] as const) {
    test(`GM-08 pull request status pill renders "${scenario.label}" (Figma: ${scenario.figma})`, async ({
      gitMeta,
      gitMetaTarget,
      seeder,
    }) => {
      const item = await gitMetaTarget.createWorkItem();
      const repo = seedRepository(gitMetaTarget.connectionId);
      const branchName = `feat/${item.ref.toLowerCase()}-${scenario.status.toLowerCase()}`;
      const terminal = scenario.status === "MERGED" || scenario.status === "CLOSED";
      await seeder.syncBranch(repo, {
        name: branchName,
        change: "UPDATED",
        url: branchUrl(repo, branchName),
        commits: [makeCommit(repo, "Status commit", 15)],
        pull_request: makePullRequest(repo, {
          number: "6112",
          title: "Wiki page analytics",
          status: scenario.status,
          closed_at: terminal ? minutesAgo(1) : null,
        }),
        links: [{ issue_id: item.id }],
      });

      await gitMeta.goto(item.url);
      await gitMeta.expandIfCollapsed();
      await expect(gitMeta.pullRequestStatusPill("6112", scenario.status)).toBeVisible();
      for (const other of ["OPEN", "MERGED", "CLOSED", "DRAFT"] as const) {
        if (other !== scenario.status) await expect(gitMeta.pullRequestStatusPill("6112", other)).toHaveCount(0);
      }
    });
  }

  for (const state of ["REVIEW_REQUIRED", "CHANGES_REQUESTED", "APPROVED"] as const) {
    test(`GM-09 review-state pill renders "${state}" alongside the Open status`, async ({
      gitMeta,
      gitMetaTarget,
      seeder,
    }) => {
      const item = await gitMetaTarget.createWorkItem();
      const repo = seedRepository(gitMetaTarget.connectionId);
      const branchName = `feat/${item.ref.toLowerCase()}-${state.toLowerCase()}`;
      await seeder.syncBranch(repo, {
        name: branchName,
        change: "REFERENCED",
        url: branchUrl(repo, branchName),
        pull_request: makePullRequest(repo, { number: "77", title: "Review me", status: "OPEN", review_state: state }),
        links: [{ issue_id: item.id }],
      });

      await gitMeta.goto(item.url);
      await gitMeta.expandIfCollapsed();
      await expect(gitMeta.pullRequestStatusPill("77", "OPEN")).toBeVisible();
      await expect(gitMeta.pullRequestReviewPill("77", state)).toBeVisible();
    });
  }

  test("GM-10 deleted branch stays listed with a Deleted pill and its PR/commits intact (Figma: branch is deleted)", async ({
    gitMeta,
    gitMetaTarget,
    seeder,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `feat/${item.ref.toLowerCase()}-deleted`;
    const commit = makeCommit(repo, "Last commit before delete", 40);
    const base: SeedBranch = {
      name: branchName,
      change: "CREATED",
      url: branchUrl(repo, branchName),
      commits: [commit],
      pull_request: makePullRequest(repo, {
        number: "6112",
        title: "Wiki page analytics",
        status: "MERGED",
        closed_at: minutesAgo(5),
      }),
      links: [{ issue_id: item.id }],
    };
    await seeder.syncBranch(repo, base, minutesAgo(10));
    await seeder.syncBranch(
      repo,
      { name: branchName, change: "DELETED", links: [{ issue_id: item.id }] },
      minutesAgo(1)
    );

    await gitMeta.goto(item.url);
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.branchDeletedPill(branchName)).toBeVisible();
    await expect(gitMeta.pullRequestStatusPill("6112", "MERGED")).toBeVisible();
    await expect(gitMeta.commitRow(commit.sha)).toBeVisible();
  });

  test("GM-11 multiple branches render as separate collapsed cards; header count matches", async ({
    gitMeta,
    gitMetaTarget,
    seeder,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const a = `feat/${item.ref.toLowerCase()}-a`;
    const b = `feat/${item.ref.toLowerCase()}-b`;
    await seeder.syncBranch(repo, {
      name: a,
      change: "CREATED",
      url: branchUrl(repo, a),
      commits: [makeCommit(repo, "A", 9)],
      links: [{ issue_id: item.id }],
    });
    await seeder.syncBranch(repo, {
      name: b,
      change: "CREATED",
      url: branchUrl(repo, b),
      commits: [makeCommit(repo, "B", 8)],
      links: [{ issue_id: item.id }],
    });

    await gitMeta.goto(item.url);
    await expect(gitMeta.headerCount()).toHaveText("2");
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.branchCard(a)).toBeVisible();
    await expect(gitMeta.branchCard(b)).toBeVisible();
    // With >1 branch neither card is open by default
    await expect(gitMeta.branchCommitRows(a)).toHaveCount(0);
    await gitMeta.toggleBranch(a);
    await expect(gitMeta.branchCommitRows(a)).toHaveCount(1);
  });

  test("GM-12 loose commit (pushed to main referencing the item) and loose PR appear in their own sections", async ({
    gitMeta,
    gitMetaTarget,
    seeder,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    // Commit straight to main whose message names the work item; main itself is NOT linked.
    const loose = makeCommit(repo, `${item.ref} hotfix on main`, 3, [{ issue_id: item.id }]);
    await seeder.syncBranch(repo, { name: "main", change: "UPDATED", url: branchUrl(repo, "main"), commits: [loose] });
    // PR whose title names the item but whose source branch was never linked and carries no reference.
    await seeder.syncBranch(repo, {
      name: "unrelated-branch-name",
      change: "REFERENCED",
      url: branchUrl(repo, "unrelated-branch-name"),
      pull_request: makePullRequest(repo, {
        number: "900",
        title: `${item.ref} loose PR`,
        links: [{ issue_id: item.id }],
      }),
    });

    await gitMeta.goto(item.url);
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.looseCommits()).toBeVisible();
    await expect(gitMeta.looseCommits().getByText("Commits", { exact: true })).toBeVisible();
    await expect(gitMeta.commitRow(loose.sha)).toBeVisible();
    await expect(gitMeta.loosePullRequests()).toBeVisible();
    await expect(gitMeta.loosePullRequests().getByText(/^Pull requests?$/)).toBeVisible();
    await expect(gitMeta.pullRequestRow("900")).toBeVisible();
    // Neither `main` nor the unlinked source branch should get a branch card
    await expect(gitMeta.branchCard("main")).toHaveCount(0);
  });

  test("GM-13 [#9730] a PR whose title references the item links its source branch too", async ({
    gitMeta,
    gitMetaTarget,
    seeder,
  }) => {
    // Silo borrows the PR's references onto the branch (`withPullRequestReferences`), so the
    // branch link is sent explicitly here — asserting the read model + UI show it under a branch card.
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = "feature/no-ref-in-name";
    await seeder.syncBranch(repo, {
      name: branchName,
      change: "REFERENCED",
      url: branchUrl(repo, branchName),
      pull_request: makePullRequest(repo, {
        number: "9730",
        title: `${item.ref} named only in PR title`,
        links: [{ issue_id: item.id }],
      }),
      links: [{ issue_id: item.id }],
    });

    const read = await seeder.read(gitMetaTarget.projectId, item.id);
    expect(read?.branches.map((b) => b.name)).toContain(branchName);
    expect(read?.pull_requests).toHaveLength(0);

    await gitMeta.goto(item.url);
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.branchCard(branchName)).toBeVisible();
    await expect(gitMeta.pullRequestRow("9730")).toBeVisible();
  });

  test("GM-19 one branch/PR/commit linked to two work items renders on both, once each, and follows the PR lifecycle", async ({
    gitMeta,
    gitMetaTarget,
    seeder,
  }) => {
    const a = await gitMetaTarget.createWorkItem();
    const b = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `feat/${a.ref.toLowerCase()}-${b.ref.toLowerCase()}-shared`;
    const links = [{ issue_id: a.id }, { issue_id: b.id }];
    const commit = makeCommit(repo, `${a.ref} ${b.ref} shared commit`, 30, links);
    const pr = makePullRequest(repo, { number: "7001", title: `${a.ref} ${b.ref} shared PR`, head_sha: commit.sha, links });

    await seeder.syncBranch(repo, {
      name: branchName,
      change: "CREATED",
      url: branchUrl(repo, branchName),
      head_sha: commit.sha,
      commits: [commit],
      pull_request: pr,
      links,
    });

    for (const item of [a, b]) {
      const read = await seeder.read(gitMetaTarget.projectId, item.id);
      expect(read?.branches.map((br) => br.name)).toEqual([branchName]);
      expect(read?.branches[0].commits.results.map((c) => c.sha)).toEqual([commit.sha]);

      await gitMeta.goto(item.url);
      await expect(gitMeta.headerCount()).toHaveText("1");
      await gitMeta.expandIfCollapsed();
      await expect(gitMeta.branchCard(branchName)).toHaveCount(1);
      await expect(gitMeta.pullRequestStatusPill("7001", "OPEN")).toBeVisible();
      await expect(gitMeta.commitRow(commit.sha)).toBeVisible();
    }

    // Merge, then delete the branch — both items must observe both transitions
    await seeder.syncBranch(repo, {
      name: branchName,
      change: "UPDATED",
      url: branchUrl(repo, branchName),
      pull_request: { ...pr, status: "MERGED", closed_at: minutesAgo(1) },
      links,
    });
    await seeder.syncBranch(repo, { name: branchName, change: "DELETED", links });

    for (const item of [a, b]) {
      await gitMeta.goto(item.url);
      await gitMeta.expandIfCollapsed();
      await expect(gitMeta.pullRequestStatusPill("7001", "MERGED")).toBeVisible();
      await expect(gitMeta.branchDeletedPill(branchName)).toBeVisible();
      await expect(gitMeta.commitRow(commit.sha)).toBeVisible();
    }
  });

  test("GM-14 actor without a connected Plane member still renders provider avatar/name", async ({
    gitMeta,
    gitMetaTarget,
    seeder,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `feat/${item.ref.toLowerCase()}-actor`;
    const commit = makeCommit(repo, "By an unknown author", 2);
    commit.actor = {
      provider: "GITHUB",
      external_id: "stranger-1",
      username: "stranger",
      display_name: "Stranger Dev",
      member_id: null,
    };
    await seeder.syncBranch(repo, {
      name: branchName,
      change: "CREATED",
      url: branchUrl(repo, branchName),
      commits: [commit],
      links: [{ issue_id: item.id }],
    });

    await gitMeta.goto(item.url);
    await gitMeta.expandIfCollapsed();
    await gitMeta.expectRowActorTooltip(gitMeta.commitRow(commit.sha), "Stranger Dev");
  });

  test("GM-15 widget refreshes on window focus after new activity lands", async ({
    gitMeta,
    page,
    gitMetaTarget,
    seeder,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `feat/${item.ref.toLowerCase()}-live`;
    const first = makeCommit(repo, "First", 4);
    await seeder.syncBranch(repo, {
      name: branchName,
      change: "CREATED",
      url: branchUrl(repo, branchName),
      commits: [first],
      links: [{ issue_id: item.id }],
    });

    await gitMeta.goto(item.url);
    await gitMeta.expandIfCollapsed();
    await expect(gitMeta.branchCommitRows(branchName)).toHaveCount(1);

    const second = makeCommit(repo, "Second", 1);
    await seeder.syncBranch(repo, {
      name: branchName,
      change: "UPDATED",
      head_sha: second.sha,
      commits: [second],
      links: [{ issue_id: item.id }],
    });
    // SWR dedupes focus revalidation within a few seconds of the mount fetch, so refocus until it bites.
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          return gitMeta.branchCommitRows(branchName).count();
        },
        { timeout: 30_000, intervals: [3_000] }
      )
      .toBe(2);
    await expect(gitMeta.branchCommitRows(branchName).first()).toContainText(second.sha.slice(0, 7));
  });

  // ---- Design-vs-implementation gaps (Figma shows these; phase one does not implement them). ----
  // Kept as fixme so the gap is visible in the report instead of silently untested.

  test.fixme("GM-16 [design gap] PR row shows review comment count (Figma: 💬 8)", async () => {
    // TGitMetaPullRequest has no comment-count field in #9200.
  });

  test.fixme("GM-17 [design gap] branch card menu offers 'Copy branch name' / 'Create branch in GitHub'", async () => {
    // Figma node 4652-97488 dropdown; no such action exists in branch-card.tsx.
  });

  test.fixme("GM-18 [design gap] Development header shows a git-branch action icon on the right", async () => {
    // Figma page frame 4569-83883 shows a trailing branch icon on the header; root.tsx renders none.
  });
});
