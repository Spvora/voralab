import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Page object for the work-item "Development" widget (Git Meta, plane-ee #9200 / #9730).
 *
 * Locators are role/text based so the suite runs against deployments that do not yet ship the
 * `data-testid` hooks. Structural facts relied on (apps/web/.../issue-detail-widgets/git-meta):
 *   - the section header is a `<button aria-expanded aria-controls>` whose text starts with
 *     "Development" followed by the aggregate count;
 *   - the expanded body is the last child of the section, and each card (branch card or loose
 *     section) is a direct child of the body's single wrapper div;
 *   - branch cards start with a `<button aria-expanded>` containing "<repo full name> / <branch>",
 *     loose cards have no header button;
 *   - PR and commit rows are `<a target="_blank">` when the provider URL is known.
 */

const LABELS = {
  title: "Development",
  showMore: "Show more",
  showLess: "Show less",
  viewAllCommits: "View all commits",
  deleted: "Deleted",
  looseTitles: { pullRequests: /^Pull requests?$/, commits: /^Commits$/ },
  prStatus: { OPEN: "Open", MERGED: "Merged", CLOSED: "Closed", DRAFT: "Draft" },
  reviewState: {
    REVIEW_REQUIRED: "Review required",
    CHANGES_REQUESTED: "Changes requested",
    APPROVED: "Approved",
  },
} as const;

export type GitMetaPrStatus = keyof typeof LABELS.prStatus;
export type GitMetaReviewState = keyof typeof LABELS.reviewState;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class GitMetaWidgetPage {
  constructor(readonly page: Page) {}

  async goto(workItemUrl: string): Promise<void> {
    await this.page.goto(workItemUrl);
    // Work-item detail is rendered once the title editor is up; the widgets hydrate right after.
    await this.page.getByRole("heading").first().waitFor({ state: "attached" });
  }

  header(): Locator {
    return this.page.getByRole("button", { name: new RegExp(`^${LABELS.title}\\b`) });
  }

  headerCount(): Locator {
    return this.header().getByText(/^\d+$/);
  }

  section(): Locator {
    return this.header().locator("xpath=ancestor::div[3]");
  }

  content(): Locator {
    return this.section().locator("> div").last();
  }

  private cards(): Locator {
    return this.content().locator("> div > div");
  }

  async expandIfCollapsed(): Promise<void> {
    const header = this.header();
    if ((await header.getAttribute("aria-expanded")) === "false") await header.click();
  }

  async collapse(): Promise<void> {
    const header = this.header();
    if ((await header.getAttribute("aria-expanded")) !== "false") await header.click();
  }

  branchToggle(branchName: string): Locator {
    return this.page.getByRole("button", { name: new RegExp(`/\\s*${escapeRegExp(branchName)}(\\s|$)`) });
  }

  branchCard(branchName: string): Locator {
    return this.cards().filter({ has: this.branchToggle(branchName) });
  }

  branchRepositoryLabel(branchName: string, repositoryFullName: string): Locator {
    return this.branchCard(branchName).getByText(`${repositoryFullName} /`, { exact: true });
  }

  branchDeletedPill(branchName: string): Locator {
    return this.branchCard(branchName).getByText(LABELS.deleted, { exact: true });
  }

  async toggleBranch(branchName: string): Promise<void> {
    await this.branchToggle(branchName).click();
  }

  /** Body labels ("Pull request" / "Commits") are only mounted while the card is open. */
  branchBody(branchName: string): Locator {
    return this.branchCard(branchName).getByText(/^(Pull requests?|Commits)$/);
  }

  async expandBranchIfCollapsed(branchName: string): Promise<void> {
    if ((await this.branchBody(branchName).count()) === 0) await this.branchToggle(branchName).click();
  }

  /** Any commit row (linked or not) whose short SHA is shown. */
  commitRow(sha: string): Locator {
    const short = sha.slice(0, 7);
    const linked = this.content().getByRole("link", { name: new RegExp(`\\b${short}\\b`) });
    // Rows without a provider URL render as a plain container holding the short sha; when the row
    // is a link it precedes its own sha span in DOM order, so `.first()` picks the row.
    const unlinked = this.content().getByText(short, { exact: true }).locator("xpath=..");
    return linked.or(unlinked).first();
  }

  branchCommitRows(branchName: string): Locator {
    return this.branchCard(branchName).getByRole("link", { name: /\b[0-9a-f]{7}\b/ });
  }

  /** The PR row is the link whose "#N" is its own number; commit rows may quote "#N" in their message. */
  pullRequestRow(number: string | number): Locator {
    return this.content()
      .getByRole("link", { name: new RegExp(`^#${number}\\b`) })
      .or(this.content().locator(`a[href$="/pull/${number}"], a[href$="/merge_requests/${number}"], a[href$="/pull-requests/${number}"]`))
      .first();
  }

  pullRequestStatusPill(number: string | number, status: GitMetaPrStatus): Locator {
    return this.pullRequestRow(number).getByText(LABELS.prStatus[status], { exact: true });
  }

  pullRequestReviewPill(number: string | number, state: GitMetaReviewState): Locator {
    return this.pullRequestRow(number).getByText(LABELS.reviewState[state], { exact: true });
  }

  pullRequestDiffStat(number: string | number, text: string): Locator {
    return this.pullRequestRow(number).getByText(text, { exact: true });
  }

  showMoreButton(branchName: string): Locator {
    return this.branchCard(branchName).getByRole("button", { name: LABELS.showMore });
  }

  showLessButton(branchName: string): Locator {
    return this.branchCard(branchName).getByRole("button", { name: LABELS.showLess });
  }

  viewAllCommitsLink(branchName: string): Locator {
    return this.branchCard(branchName).getByRole("link", { name: LABELS.viewAllCommits });
  }

  /** Cards without a "<repo> / <branch>" header toggle are the loose ("unassociated") sections. */
  private looseCards(): Locator {
    return this.cards().filter({ hasNot: this.page.getByRole("button", { name: /\s\/\s/ }) });
  }

  loosePullRequests(): Locator {
    return this.looseCards().filter({ has: this.page.getByText(LABELS.looseTitles.pullRequests) });
  }

  looseCommits(): Locator {
    return this.looseCards().filter({ has: this.page.getByText(LABELS.looseTitles.commits) });
  }

  rowActor(row: Locator, displayName: string): Locator {
    return row.getByText(displayName, { exact: false }).or(row.getByRole("img", { name: displayName }));
  }

  /**
   * An actor without an avatar image renders only its initial; the full name lives in the hover
   * tooltip. Hover the row's trailing avatar and assert the tooltip names the actor.
   */
  async expectRowActorTooltip(row: Locator, displayName: string): Promise<void> {
    const avatar = row.getByText(displayName.charAt(0), { exact: true }).last();
    await avatar.hover();
    await expect(this.page.getByText(displayName, { exact: true })).toBeVisible();
  }

  /** Reload the work item and wait for the widget's read request to settle. */
  async reloadAndWaitForGitMeta(): Promise<void> {
    await Promise.all([
      this.page.waitForResponse((response) => response.url().includes("/git-meta/") && response.request().method() === "GET"),
      this.page.reload(),
    ]);
  }

  /**
   * Provider → silo → Plane propagation is asynchronous and the widget does not poll, so after a
   * mutation reload the page until `locator` (optionally with a branch card expanded) is present.
   */
  async reloadUntilVisible(locator: Locator, options: { timeout: number; branch?: string }): Promise<void> {
    await expect
      .poll(
        async () => {
          await this.page.reload();
          await this.header().waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
          await this.expandIfCollapsed().catch(() => undefined);
          if (options.branch) await this.expandBranchIfCollapsed(options.branch).catch(() => undefined);
          return (await locator.count()) > 0;
        },
        { timeout: options.timeout, intervals: [5_000] }
      )
      .toBeTruthy();
    await expect(locator).toBeVisible();
  }
}
