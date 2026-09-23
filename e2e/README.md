# Git Meta E2E (Playwright)

Playwright TypeScript suite for Plane's **Development** widget (Git Meta, plane-ee #9200 / #9730), run
against a deployed Plane instance (default `https://silo.runway.plane.town`) with this repository
(`Spvora/voralab`) as the connected GitHub repo.

## Setup

```bash
cd e2e
npm install
npx playwright install chromium
cp .env.example .env   # fill in E2E_PLANE_EMAIL / E2E_PLANE_PASSWORD (+ tokens below)
```

## Run

```bash
npm test                # everything that is configured
npm run test:widget     # GM-* widget states (needs E2E_GIT_META_TOKEN + connection id)
npm run test:api        # GA-* v2 sync contract (needs E2E_GIT_META_TOKEN + connection id)
npm run test:live       # GL-* real GitHub → silo → widget (needs E2E_GITHUB_TOKEN)
npm run test:smoke      # GS-01 read-only check of pre-existing data (login only)
npm run check:types
E2E_RUN_KNOWN_BUGS=1 npx playwright test -g "GM-07|GL-11"   # reproduce the quarantined bugs (video on failure)
```

Specs skip themselves (not fail) when their inputs are missing:

| Spec                              | Needs                                                                 |
| --------------------------------- | --------------------------------------------------------------------- |
| `tests/git-meta.smoke.spec.ts`    | Plane login + project env only (defaults target GITMETAQA-21; override `E2E_SMOKE_*`) |
| `tests/git-meta.widget.spec.ts`   | Plane login, project env, `E2E_GIT_META_TOKEN` (`git.meta` OAuth scope) |
| `tests/git-meta.api.spec.ts`      | same as widget                                                        |
| `tests/git-meta.github-live.spec.ts` | Plane login, project env, `E2E_GITHUB_TOKEN` with contents + PR write |

## Coverage

- **GS-01** smoke against existing data: header count, branch card, PR row (Open pill, direction,
  href), commit rows, loose commits, Show more/less on a 14-commit branch, Merged pill, collapse.

- **GM-01..19** widget states mapped to the Figma "Git meta" frames: empty, PR + commits, whole-row
  external links, collapse/expand, no-PR branch, >5 commits (Show more/less), server-paginated
  `View all commits`, Open/Merged/Closed/Draft pills, review-state pills, deleted branch, multiple
  branches + counts, loose commits/PRs, PR-title-only linking (#9730), unknown actor, focus refresh,
  one PR/commit linked to two work items. GM-16..18 are `fixme` design gaps not in phase one.
- **GA-01..10** v2 sync contract: idempotent replay, force-push dedupe, stale merged → open rejected,
  closed → reopened, terminal PR without `closed_at` rejected, cross-workspace link rejected, auth,
  unknown work item, `linked_by` provenance, actor upsert.
- **GL-01..12** live GitHub lifecycle: push, open → approve → merge, close → reopen, draft,
  PR-title-only link + follow-up push race, force-push, branch delete, loose commit, unrelated push,
  PR/commit shared by two work items, merge + delete on a shared PR, close + delete.

Everything the live suite creates is prefixed with the work-item ref (`GITMETAQA-<n>-live-*`) and
branches are deleted in `afterAll`; PRs stay for inspection.
