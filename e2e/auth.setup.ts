import { test as setup, expect, request } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { AUTH_STATE, WEB_URL } from "./playwright.config";
import { PlaneApi } from "./utils/plane-api";

/**
 * Signs in once through the app API and stores the session cookie for the `web` project. Runs before
 * every spec; skipped (and all dependent specs fail loudly) when the login env is missing.
 */
setup("authenticate against the Plane instance", async () => {
  const email = process.env.E2E_PLANE_EMAIL;
  const password = process.env.E2E_PLANE_PASSWORD;
  expect(email, "E2E_PLANE_EMAIL is required").toBeTruthy();
  expect(password, "E2E_PLANE_PASSWORD is required").toBeTruthy();

  const context = await request.newContext({ baseURL: WEB_URL });
  const api = new PlaneApi(context);
  await api.signIn(email!, password!);

  const state = await context.storageState();
  expect(state.cookies.some((cookie) => cookie.name.includes("session-id")), "session cookie set").toBe(true);

  fs.mkdirSync(path.dirname(AUTH_STATE), { recursive: true });
  fs.writeFileSync(AUTH_STATE, JSON.stringify(state, null, 2));
  await context.dispose();
});
