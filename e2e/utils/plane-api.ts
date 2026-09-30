import type { APIRequestContext } from "@playwright/test";
import { API_URL } from "../playwright.config";

export type WorkItem = { id: string; name: string; sequence_id: number };

/**
 * Thin client over the Plane instance under test.
 *
 * - `/auth/...` and `/api/...` are the app API, authenticated by the `session-id` cookie held on the
 *   request context after `signIn`.
 * - `/api/v1/...` is the external API, authenticated by an `X-Api-Key` minted via `mintWorkspaceToken`.
 * - `/api/v2/.../git-meta/` (see git-meta-seed.ts) needs an OAuth bearer with the `git.meta` scope.
 */
export class PlaneApi {
  constructor(readonly request: APIRequestContext) {}

  async getCsrfToken(): Promise<string> {
    const response = await this.request.get(`${API_URL}/auth/get-csrf-token/`);
    if (!response.ok()) throw new Error(`getCsrfToken failed: ${response.status()} ${await response.text()}`);
    const { csrf_token } = (await response.json()) as { csrf_token: string };
    return csrf_token;
  }

  async signIn(email: string, password: string): Promise<void> {
    const csrf = await this.getCsrfToken();
    const response = await this.request.post(`${API_URL}/auth/sign-in/`, {
      form: { email, password, csrfmiddlewaretoken: csrf },
      headers: { Origin: API_URL, Referer: `${API_URL}/` },
      maxRedirects: 0,
    });
    const location = response.headers()["location"] ?? "";
    if (response.status() !== 302 || location.includes("error_code")) {
      throw new Error(`sign-in failed: ${response.status()} → ${location}`);
    }
  }

  async mintWorkspaceToken(slug: string): Promise<string> {
    const csrf = await this.getCsrfToken();
    const response = await this.request.post(`${API_URL}/api/workspaces/${slug}/api-tokens/`, {
      data: { label: `git-meta-e2e-${Date.now()}` },
      headers: { "X-CSRFTOKEN": csrf },
    });
    if (!response.ok()) throw new Error(`mintWorkspaceToken failed: ${response.status()} ${await response.text()}`);
    const { token } = (await response.json()) as { token: string };
    return token;
  }

  async createWorkItem(slug: string, projectId: string, name: string, token: string): Promise<WorkItem> {
    const response = await this.request.post(`${API_URL}/api/v1/workspaces/${slug}/projects/${projectId}/work-items/`, {
      data: { name },
      headers: { "X-Api-Key": token },
    });
    if (!response.ok()) throw new Error(`createWorkItem failed: ${response.status()} ${await response.text()}`);
    const { id } = (await response.json()) as { id: string };
    return this.retrieveWorkItem(slug, projectId, id, token);
  }

  async retrieveWorkItem(slug: string, projectId: string, workItemId: string, token: string): Promise<WorkItem> {
    const response = await this.request.get(
      `${API_URL}/api/v1/workspaces/${slug}/projects/${projectId}/work-items/${workItemId}/`,
      { headers: { "X-Api-Key": token } }
    );
    if (!response.ok()) throw new Error(`retrieveWorkItem failed: ${response.status()} ${await response.text()}`);
    return (await response.json()) as WorkItem;
  }

  /** Work-item detail URL as the web app routes it. */
  workItemUrl(slug: string, projectId: string, workItemId: string): string {
    return `/${slug}/projects/${projectId}/issues/${workItemId}/`;
  }
}
