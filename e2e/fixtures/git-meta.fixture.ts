import { test as base, request, type APIRequestContext, type TestInfo } from "@playwright/test";
import { AUTH_STATE, WEB_URL } from "../playwright.config";
import { GitMetaWidgetPage } from "../pom/git-meta-widget.page";
import { GitMetaSeeder, gitMetaEnv } from "../utils/git-meta-seed";
import { PlaneApi, type WorkItem } from "../utils/plane-api";
import { RUN_ID, uid } from "../utils/unique";

export type GitMetaWorkItem = WorkItem & { ref: string; url: string };

export type GitMetaTarget = {
  workspaceSlug: string;
  projectId: string;
  projectIdentifier: string;
  connectionId: string | undefined;
  /** Creates a fresh work item in the target project; returns its `PROJ-123` ref and detail URL. */
  createWorkItem: (name?: string) => Promise<GitMetaWorkItem>;
};

type WorkerFixtures = {
  api: PlaneApi;
};

type TestFixtures = {
  gitMetaTarget: GitMetaTarget;
  seeder: GitMetaSeeder;
  gitMeta: GitMetaWidgetPage;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  api: [
    async ({}, use) => {
      const context: APIRequestContext = await request.newContext({ baseURL: WEB_URL, storageState: AUTH_STATE });
      await use(new PlaneApi(context));
      await context.dispose();
    },
    { scope: "worker" },
  ],

  gitMetaTarget: async ({ api }, use, testInfo) => {
    const workspaceSlug = process.env.E2E_GIT_META_WORKSPACE_SLUG;
    const projectId = process.env.E2E_GIT_META_PROJECT_ID;
    const projectIdentifier = process.env.E2E_GIT_META_PROJECT_IDENTIFIER;

    testInfo.skip(
      !(workspaceSlug && projectId && projectIdentifier),
      "Git Meta target not configured (E2E_GIT_META_WORKSPACE_SLUG / _PROJECT_ID / _PROJECT_IDENTIFIER)"
    );

    const token = await api.mintWorkspaceToken(workspaceSlug!);

    await use({
      workspaceSlug: workspaceSlug!,
      projectId: projectId!,
      projectIdentifier: projectIdentifier!,
      connectionId: gitMetaEnv().connectionId,
      createWorkItem: async (name = `[e2e ${RUN_ID}] Git meta ${uid()}`) => {
        const item = await api.createWorkItem(workspaceSlug!, projectId!, name, token);
        return {
          ...item,
          ref: `${projectIdentifier}-${item.sequence_id}`,
          url: api.workItemUrl(workspaceSlug!, projectId!, item.id),
        };
      },
    });
  },

  seeder: async ({ api, gitMetaTarget }, use) => {
    await use(new GitMetaSeeder(api.request, gitMetaTarget.workspaceSlug));
  },

  gitMeta: async ({ page }, use) => {
    await use(new GitMetaWidgetPage(page));
  },
});

/** Skips the test unless the `git.meta` bearer + connection id are configured (seeded/API specs). */
export const requireSeedEnv = (testInfo: TestInfo) => {
  testInfo.skip(!gitMetaEnv().configured, "E2E_GIT_META_TOKEN / E2E_GIT_META_WORKSPACE_CONNECTION_ID not set");
};

export { expect } from "@playwright/test";
