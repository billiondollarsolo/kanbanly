# Close-out checklist

Status of residual gaps vs the product plan (`docs/specs/…`).  
**MVP mechanics for US-1…32 are shipped.** This list is what remains for a literal 100% plan close.

Legend: `[x]` done in code · `[ ]` still needs human/CI/env · `[~]` partial

---

## A. Verification gaps (plan AC)

| # | Item | Spec | In code | Notes |
|---|------|------|---------|--------|
| A1 | Playwright real-browser drag lands card | US-17 | [~] | Required: API drop→commit. Optional: Playwright keyboard move + drag specs (`e2e/tests`). Needs `bunx playwright install chromium` |
| A2 | Assert git commit after drag/move | US-18 | [x] | `e2e-drag-commit.test.ts` always runs via `test:e2e` |
| A3 | Screen-reader verification | US-30 | [~] | Skip link, `aria-live` focus announcements, help dialog, focus-visible; **human** SR pass remains |
| A4 | Path deep links `/r/<slug>/b/<board>` | US-15 | [x] | Path History API + SPA shell for `/b/*` and `/r/*/b/*`; hash still parsed |
| A5 | Node / `npx` best-effort | NFR-9 | [x] | `bin/kanbanly`, `runMergeDriverSync`, `bun run test:node` |
| A6 | Credential layout encrypted + 0600 | NFR-6 | [x] | AES-GCM; repo store + `~/.kanbanly/credentials.json` + `~/.kanbanly/key` |

## B. Definition of Done automation

| # | Item | In code |
|---|------|---------|
| B1 | `bun test` | [x] |
| B2 | `bun run typecheck` | [x] |
| B3 | `bun run lint` | [x] |
| B4 | `bun run build` | [x] |
| B5 | `bun run test:e2e` | [~] commit path required; Playwright optional if browsers missing |
| B6 | `bun run test:conformance` | [x] |
| B7 | Docker is default OSS run posture | [x] `docker compose -f deploy/compose.yaml up --build` / `bun start` |
| B8 | WCAG AA automated | [x] palette contrast tests |
| B9 | Docker image build in CI | [ ] optional; local compose is the documented default |

## C. Explicit non-goals (do not block close)

- OSS multi-user auth (loopback + `--host` warning by design)
- SaaS billing / full enterprise portfolio product
- Live human screen-reader certification
- Publishing to npm registry

## D. Close-out commands (run before tag)

```bash
bun install
bun run test:closeout      # typecheck + lint + tests + conformance + e2e + node + build
# or step-by-step:
bun run build && bun run typecheck && bun run lint
bun test packages/core packages/server kanbanly-saas apps/start
bun run test:conformance && bun run test:e2e && bun run test:node
# optional full browser e2e:
# bunx playwright install chromium && bunx playwright test -c e2e/playwright.config.ts
# Default OSS run (Docker):
# docker compose -f deploy/compose.yaml up --build
# curl -sf http://127.0.0.1:3847/health
```

## E. Human QA (cannot fully automate)

1. VoiceOver/NVDA: tab board, hear card announcements, open detail, escape.
2. Manual Playwright drag in headed mode once.
3. Docker default smoke: `docker compose -f deploy/compose.yaml up --build` → UI at http://127.0.0.1:3847/ + `/health` + `/api/boards`.
4. Connect wizard against a real GitHub HTTPS remote with PAT.
