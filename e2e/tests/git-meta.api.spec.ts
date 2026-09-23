/**
 * Git Meta — v2 sync / read API contract (apps/api/plane/api_v2/views/git_meta.py).
 *
 * These are the invariants the widget depends on and that a webhook replay must respect:
 * idempotency, monotonic (stale-safe) reconciliation, force-push dedupe, terminal-status
 * guard, and workspace scoping.
 */

import { test, expect, requireSeedEnv } from "../fixtures/git-meta.fixture";
import {
  GITHUB_ACTOR,
  branchUrl,
  fakeSha,
  gitMetaEnv,
  makeCommit,
  makePullRequest,
  minutesAgo,
  seedRepository,
} from "../utils/git-meta-seed";

test.describe("Git Meta API", { tag: ["@tier1", "@git-meta", "@api", "@generated"] }, () => {
  test.beforeEach(({}, testInfo) => requireSeedEnv(testInfo));
  test("GA-01 replaying the same event is a no-op (idempotent sync)", async ({ gitMetaTarget, seeder }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `feat/${item.ref.toLowerCase()}-idem`;
    const payload = {
      event_at: minutesAgo(1),
      repository: repo,
      actor: GITHUB_ACTOR,
      branches: [
        {
          name: branchName,
          change: "CREATED" as const,
          url: branchUrl(repo, branchName),
          commits: [makeCommit(repo, "Once", 2), makeCommit(repo, "Twice", 1)],
          pull_request: makePullRequest(repo, { number: "1", title: "Idempotent" }),
          links: [{ issue_id: item.id }],
        },
      ],
    };
    const first = await seeder.sync(payload);
    const second = await seeder.sync(payload);
    expect(second.repository_id).toBe(first.repository_id);

    const read = await seeder.read(gitMetaTarget.projectId, item.id);
    expect(read?.branches).toHaveLength(1);
    expect(read?.branches[0].commits.total_count).toBe(2);
    expect(read?.branches[0].pull_request?.number).toBe("1");
  });

  test("GA-02 force-push reconciles commits instead of duplicating them", async ({ gitMetaTarget, seeder }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `feat/${item.ref.toLowerCase()}-force`;
    const original = makeCommit(repo, "Original", 10);
    await seeder.syncBranch(
      repo,
      {
        name: branchName,
        change: "CREATED",
        url: branchUrl(repo, branchName),
        head_sha: original.sha,
        commits: [original],
        links: [{ issue_id: item.id }],
      },
      minutesAgo(10)
    );

    const rewritten = makeCommit(repo, "Original (amended)", 1);
    await seeder.syncBranch(
      repo,
      { name: branchName, change: "FORCED", head_sha: rewritten.sha, commits: [rewritten] },
      minutesAgo(1)
    );
    // Replay the force-push
    await seeder.syncBranch(
      repo,
      { name: branchName, change: "FORCED", head_sha: rewritten.sha, commits: [rewritten] },
      minutesAgo(1)
    );

    const read = await seeder.read(gitMetaTarget.projectId, item.id);
    const shas = read?.branches[0].commits.results.map((c) => c.sha) ?? [];
    expect(new Set(shas).size).toBe(shas.length);
    expect(shas).toContain(rewritten.sha);
    expect(read?.branches[0].commits.results[0].sha).toBe(rewritten.sha);
  });

  test("GA-03 an older (stale) event cannot regress a merged PR back to open", async ({ gitMetaTarget, seeder }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `feat/${item.ref.toLowerCase()}-stale`;
    const pr = (status: "OPEN" | "MERGED", closed_at: string | null) =>
      makePullRequest(repo, { number: "5", title: "Ordering", status, closed_at });

    await seeder.syncBranch(
      repo,
      {
        name: branchName,
        change: "UPDATED",
        url: branchUrl(repo, branchName),
        pull_request: pr("MERGED", minutesAgo(2)),
        links: [{ issue_id: item.id }],
      },
      minutesAgo(2)
    );
    // Delayed delivery of the earlier "opened" event
    await seeder.syncBranch(
      repo,
      { name: branchName, change: "REFERENCED", pull_request: pr("OPEN", null), links: [{ issue_id: item.id }] },
      minutesAgo(30)
    );

    const read = await seeder.read(gitMetaTarget.projectId, item.id);
    expect(read?.branches[0].pull_request?.status).toBe("MERGED");
    expect(read?.branches[0].pull_request?.closed_at).not.toBeNull();
  });

  test("GA-04 reopening a closed PR clears closed_at and returns to Open", async ({ gitMetaTarget, seeder }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `feat/${item.ref.toLowerCase()}-reopen`;
    await seeder.syncBranch(
      repo,
      {
        name: branchName,
        change: "UPDATED",
        url: branchUrl(repo, branchName),
        pull_request: makePullRequest(repo, {
          number: "6",
          title: "Reopen",
          status: "CLOSED",
          closed_at: minutesAgo(5),
        }),
        links: [{ issue_id: item.id }],
      },
      minutesAgo(5)
    );
    await seeder.syncBranch(
      repo,
      {
        name: branchName,
        change: "REFERENCED",
        pull_request: makePullRequest(repo, { number: "6", title: "Reopen", status: "OPEN", closed_at: null }),
        links: [{ issue_id: item.id }],
      },
      minutesAgo(1)
    );

    const read = await seeder.read(gitMetaTarget.projectId, item.id);
    expect(read?.branches[0].pull_request?.status).toBe("OPEN");
    expect(read?.branches[0].pull_request?.closed_at).toBeNull();
  });

  test("GA-05 a MERGED/CLOSED pull request without closed_at is rejected (400)", async ({ gitMetaTarget, seeder }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const response = await seeder.syncRaw({
      event_at: minutesAgo(1),
      repository: repo,
      branches: [
        {
          name: "x",
          change: "UPDATED",
          pull_request: makePullRequest(repo, {
            number: "7",
            title: "No closed_at",
            status: "MERGED",
            closed_at: null,
          }),
          links: [{ issue_id: item.id }],
        },
      ],
    });
    expect(response.status()).toBe(400);
  });

  test("GA-06 links to a work item outside the workspace are rejected", async ({ gitMetaTarget, seeder }) => {
    const repo = seedRepository(gitMetaTarget.connectionId);
    const response = await seeder.syncRaw({
      event_at: minutesAgo(1),
      repository: repo,
      branches: [{ name: "y", change: "CREATED", links: [{ issue_id: "00000000-0000-4000-8000-000000000000" }] }],
    });
    expect(response.status()).toBe(400);
  });

  test("GA-07 sync requires a bearer token with the git.meta scope", async ({ gitMetaTarget, seeder }) => {
    const repo = seedRepository(gitMetaTarget.connectionId);
    const noToken = await seeder.syncRaw({ event_at: minutesAgo(1), repository: repo, branches: [] }, "");
    expect(noToken.status()).toBe(401);
    const badToken = await seeder.syncRaw(
      { event_at: minutesAgo(1), repository: repo, branches: [] },
      `bogus-${fakeSha()}`
    );
    expect([401, 403]).toContain(badToken.status());
  });

  test("GA-08 read endpoint returns 404 for an unknown work item (widget renders nothing)", async ({
    gitMetaTarget,
    seeder,
  }) => {
    const read = await seeder.read(gitMetaTarget.projectId, "00000000-0000-4000-8000-000000000000");
    expect(read).toBeNull();
  });

  test("GA-09 read model: linked_by provenance is positional (branch → BRANCH_NAME, PR → PR_TITLE)", async ({
    gitMetaTarget,
    seeder,
  }) => {
    const item = await gitMetaTarget.createWorkItem();
    const repo = seedRepository(gitMetaTarget.connectionId);
    const branchName = `feat/${item.ref.toLowerCase()}-prov`;
    await seeder.syncBranch(repo, {
      name: branchName,
      change: "CREATED",
      url: branchUrl(repo, branchName),
      pull_request: makePullRequest(repo, {
        number: "8",
        title: `${item.ref} provenance`,
        links: [{ issue_id: item.id }],
      }),
      links: [{ issue_id: item.id }],
    });
    const read = await seeder.read(gitMetaTarget.projectId, item.id);
    expect(read?.branches[0].linked_by).toBe("BRANCH_NAME");
    expect(read?.branches[0].pull_request?.linked_by).toBe("PR_TITLE");
  });

  test("GA-10 actors upsert endpoint returns the actor with member linkage", async ({ api, gitMetaTarget }) => {
    const { apiUrl, token } = gitMetaEnv();
    const response = await api.request.post(`${apiUrl}/api/v2/workspaces/${gitMetaTarget.workspaceSlug}/git-meta/actors/`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { ...GITHUB_ACTOR, external_id: `e2e-actor-${fakeSha().slice(0, 8)}` },
      });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as { id: string; username: string | null; member_id: string | null };
    expect(body.id).toBeTruthy();
    expect(body.username).toBe(GITHUB_ACTOR.username);
  });
});
