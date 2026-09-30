import { randomBytes } from "node:crypto";

/** Short random id for names/refs that must not collide across runs. */
export const uid = (): string => randomBytes(4).toString("hex").slice(0, 6);

/** Run-scoped prefix so leftovers on the shared runway environment are easy to spot and clean up. */
export const RUN_ID = process.env.E2E_RUN_ID ?? Date.now().toString(36);
