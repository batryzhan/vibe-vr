# Nap — Full Repository Map

Scan of `E:\opensource_projects\nap` — ~600 files. What it is, and where what lives.

## 0. What this repo is

**Nap** is a Lovable-style AI app builder:

> user prompt in chat → durable queued `Turn` → worker runs `Runtime` → `AgentService` drives model loop with 6 sandbox-proxy tools → writes code into isolated **E2B sandbox** → commits → runs project checks (`@vibe-vr/verify`) → `checkpoint` if green, bounded repair turn if red → live preview + event log over WebSocket.

Three processes, one composition:

```
Browser (apps/web, Next.js)
  | HTTP + /ws?seq=N
  v
API (apps/api/src/index.ts) -> Postgres turn_requests -> Worker (worker.ts) -> Runtime -> E2B
  ^                               |                         |
  +---- event log (append then fanout) <---------------------+
Reaper (reaper.ts): idle sweep, capacity reconcile, janitor, rate-event sweep. Exactly 1 replica.
```

Key vocab — `CONTEXT.md`: `Project > Session > Turn > Job`, `Checkpoint` (verified commit) vs `Snapshot` (archived FS in R2), `Lease`, `Turn request`, `Fanout (notify-then-read)`, `Verification`, `Continuation` vs `Resume`. NapBench vocab (`Task` vs `Job`, `Check`, `Gate`, `Run`, `Trajectory`, `Product half / Objective half`) and load vocab (`Journey`, `Calibration`, `Threshold`) are kept separate on purpose.

Stack: `Bun 1.3.13` (install + run + API runtime), `TypeScript strict`, `Hono + Bun.serve`, `Next.js 16`, `Drizzle + Postgres`, `R2` snapshots, `E2B` sandboxes, `OpenRouter` models, `Vitest 4` (not `bun test`), `Turbo`, `Biome`, `lefthook`, `k6 + kind + KEDA` for scale, `Python/harbor` for external harness.

> Commands: `bun run test:fast` (unit+type+web, no Docker), `bun run test` (+db, needs Docker), `bun run harness "<prompt>"`, `bun run ws:smoke`, `bun run dev / dev:worker / dev:reaper`, `bun run napbench`, `bun run loadgen*`, `infra/k8s/proof|load/run.sh`.

---

## 1. Root — config + gates

| Path | What |
|---|---|
| `package.json` | Monorepo root. `workspaces: packages/*, apps/*`. Scripts: `test/test:fast/test:integration`, `typecheck (turbo + tsc)`, `harness`, `ws:smoke`, `loadgen*`, `napbench*`, `harbor:tasks`, `lint:py/test:py`, `dev/dev:worker/dev:reaper`, `build`. Deps: `biome, turbo, vitest, lefthook, railway SDK`. |
| `turbo.json` | `build/typecheck/lint/dev/dev:worker/dev:reaper` tasks + env passthrough (`DATABASE_URL`, `VIBE_VR_*`). |
| `vitest.config.ts` | **5 projects split by filename, not dir**: `unit (*.test.ts)`, `types (*.test-d.ts, typecheck only)`, `db (*.db.test.ts, Postgres container, `globalSetup`)`, `web (*.test.tsx, jsdom+React)`, `integration (*.integration.test.ts, 120s timeout, loads `.env`)`. Wrong suffix = silently not collected. |
| `tsconfig.json / tsconfig.base.json / tsconfig.test-d.json` | Root pass covers `test/` + configs; `.test-d` program covers all type tests; `.railway/railway.ts` named as file (dot-paths are skipped by wildcards). |
| `biome.json`, `lefthook.yml` | Format/lint owner = Biome. Pre-commit: `biome + typecheck + vitest --changed` + `ruff/pytest` if `*.py` touched. Same in CI. |
| `Dockerfile`, `.dockerignore`, `.vercelignore` | One image, three entrypoints (`index/worker/reaper.ts`). Web on Vercel (`apps/web`, root dir set there). |
| `CLAUDE.md` | How to work here: commands, definition-of-done (5 gates), TS/Zod/error conventions, layout, dependency direction, component ownership, testing rules, session protocol (now GitHub issues, not `PROGRESS.md`). |
| `CONTEXT.md` | Canonical glossary — one concept, one name. Read before naming anything. |
| `README.md` | Consequences (not mechanisms). Map table, architecture picture, evidence table, run instructions. |
| `PROGRESS.md`, `docs/PLAN.md` | **Frozen v1 record.** PLAN §0-§4 = spec + task list; PROGRESS = per-task status. Do not extend. |
| `SECURITY.md`, `LICENSE (MIT)` | Vulnerability reporting, license. |
| `.claude/settings.json`, `.claude/skills/nap-events|nap-session/SKILL.md` | Hooks + agent skills for events/session protocol. |
| `.github/workflows/ci.yml` | CI on `main` + `feat/**`: biome + typecheck + vitest + `lint:py/test:py` + k8s/railway/architecture guards. |
| `.railway/railway.ts` | Railway IaC (TS): `nap-api` (`/health`), `nap-worker` (no healthcheck, `worker.ts`), `nap-reaper` (exactly 1, `reaper.ts`). Replaced deprecated `railway*.json`. Guarded by `test/railway.test.ts`. |
| `scripts/demo-cuts.sh` | Cuts `docs/demo.gif` from full session. |

---

## 2. `apps/web` — Next.js UI (chat + preview + docs)

Next 16 app on `:3000`. `next.config.ts`, `postcss.config.mjs`, `vercel.json`, `.env.example`, `AGENTS.md`, `CLAUDE.md` (web-local notes).

Routes (`src/app/`): `page.tsx` (landing), `dashboard/page.tsx`, `p/[projectId]/page.tsx` (workspace), `sign-in|sign-up|welcome/page.tsx`, `docs/page.tsx`, `layout.tsx`, `globals.css`, `icon.svg`, `opengraph|twitter-image.*`.

| Folder | Contains |
|---|---|
| `landing/` | `landing.tsx`, `live-landing.tsx`, `hero.tsx`, `headline.tsx`, `how-it-works.tsx`, `capabilities.tsx`, `closing-cta.tsx`, `way-in.tsx`, `site-header|footer.tsx`, `section-heading.tsx`, `emphasis.tsx`, `doodles.tsx`, `github-button.tsx`, `demo/live-stage.tsx + script.ts + cursor.tsx + use-playing.ts`, `use-reveal.ts`, `use-space-scale.ts`. All with `*.test.tsx/ts`. |
| `chat/` | Transcript fold + submission: `transcript.ts`, `chat-transcript.tsx`, `chat-input.tsx`, `use-turn-submission.ts`, `use-models.ts`, `model-picker.tsx`, `first-prompt.ts + use-first-prompt.ts`, `job-history.ts(x)`, `job-strip.tsx`, `job-marks.tsx`, `job-summary.ts`, `step-group.ts + step-group-card.tsx`, `tool-step.tsx`, `output-block.tsx`, `streaming-text.tsx`, `working-state.ts + working-indicator.tsx`, `unseen.ts + unseen-card.tsx + unseen-summary.ts + use-seen-cursor.ts + use-unseen-card.ts`, `use-stick-to-bottom.ts`, `composer-menu.ts`, `transcript-skeleton.tsx`. |
| `workspace/` | `workbench.tsx`, `code-pane.tsx`, `workspace-header.tsx`, `tabs.ts`, `split.ts`, `route-path.ts`, `use-pane-width.ts`. |
| `components/` | `app-shell.tsx`, `chat-pane.tsx`, `live-chat-pane.tsx`, `preview-pane.tsx`, `file-tree-pane.tsx`, `pane.tsx`, `resume-flow.tsx`. |
| `dashboard/` | `dashboard.tsx + live-dashboard.tsx`, `dashboard-hero.tsx`, `project-card|grid.tsx`, `sidebar.tsx`, `filters.ts`, `relative-time.ts`, `thumbnail-url.ts`, `example-prompts.ts`, `nap-stickers.tsx`, `use-dictation.ts`. |
| `files/` | `tree.ts`, `changed-paths.ts`, `file-viewer.tsx`, `use-project-files.ts`. |
| `preview/` | `preview-state.ts` (which `preview.ready seq` is live). |
| `projects/` | `project-phase.ts` (single `opening/idle/starting/running/put-away/failed` fold), `use-projects.ts`, `use-start-project.ts`. |
| `hooks/` | `use-event-stream.ts` (`/ws?seq=N` resume), `use-session-log.ts` (one log per workspace). |
| `auth/ + account/ + api/` | `client.ts`, `sign-in-form.tsx`, `live-sign-in.tsx`, `mode-path.ts`, `doodle-wall.tsx`, `api-key-form|panel.tsx`, `use-api-key.ts`, `welcome.tsx`, `credentialed-fetch.ts`. |
| `docs/` | Public `/docs` page (mechanism numbers live **only** here): `docs-page.tsx + docs-nav.tsx + sections.tsx + prose.tsx`, `architecture.tsx`, `how-nap-works.tsx`, `event-model.tsx`, `durable-jobs.tsx`, `sandbox.tsx`, `verification.tsx`, `napbench.tsx`, `scale.tsx`, `decisions.tsx`. |
| `brand/glow/liquid/ui/errors/badge-trail/` | Visual system: `nap-mark.tsx + nap-mark-paths.ts`, `nap-loader.tsx`, `nap-tricks.ts`, `lit-box/rim-glow/morph-card/rising-text/mask/palette/use-pulse/use-rim-mask/variants`, `marching-squares/sdf/skin`, `editable-title/icons/splitter/use-document-scroll-lock/use-elapsed`, `failure-copy/failure-surfaces/expired-session`, `badges/geometry/badge-trail`. |
| `testing/` | `setup.ts` (jsdom), `fake-socket.ts`, `events.ts`, `job-events.ts`, `audit-session.ts + .json` (context-size audit). |
| `public/demo.mp4`, `demo-poster.jpg` | Landing demo assets (`docs/demo.gif` is the cut). |

---

## 3. `apps/api` — Hono API + worker + reaper (all on `:3001`)

Three entrypoints, one `bootNap` composition (`src/boot.ts` + `compose.ts`, `env.ts`, `logger.ts`, `log-ids.ts`, `metrics.ts`, `health.ts`, `app.ts`):

* `src/index.ts` — serves, admits nothing else, executes nothing.
* `src/worker.ts` — claims leases, runs `Runtime`, serves nothing. Heartbeat in `worker-heartbeat.ts`.
* `src/reaper.ts` — sweeps idle, reconciles capacity, janitor, rate-event sweep. Exactly one via advisory lock.

| Folder/file | Role |
|---|---|
| `auth/` | `auth.ts + auth.db.test.ts`, `require-user.ts`, `owned-session.ts`, `route-table.ts + route-coverage.test.ts`, `cross-site.ts`, `authorization.test.ts`. AuthN/Z + ownership + route inventory. |
| `account/` | `routes.ts`, `api-key.ts`, `secret-box.ts` (key encryption). Bring-your-own-key, free vs paid tier. |
| `projects/routes.ts` | Project CRUD, close/delete (asks `anyLeased` = busy), phase inputs. |
| `turns/` | `routes.ts` (admission: ceilings, allowance, `resolveTurnAccess`), `model-access.ts` (which models/keys allowed), `registry.ts` (in-process turn handles), `sandbox-quota.ts` (cheap admission refusal; authoritative ceiling is reservation in Runtime). |
| `files/` | `routes.ts + params.ts` — file read/list over sandbox. |
| `models/routes.ts` | Model list for picker. |
| `ws/` | `event-stream.ts` (append-then-fanout subscribe, `seq` resume), `query.ts` (catch-up read). `event-stream.db|test.ts`, `query.test.ts`. |
| `boot-line.ts`, `split.db.test.ts`, `probes.db.test.ts`, `placeholder.test.ts` | Composition wiring, DB split-brain, liveness/readiness (`/livez /readyz`), placeholder guards. |
| `k6/ramp.js` | k6 VU script for `loadgen:ramp` (to 100, profiles `smoke/extended/saturate/realism`). |
| `scripts/` | `loadgen.ts` (in-process users), `loadgen-ramp.ts` (hold open for k6), `loadgen-composition.ts` (real API + fake sandbox/model + real PG), `loadgen-cluster.ts` (k6 vs k8s sampler), `loadgen-sandbox-store.ts` (shared PG-backed fake sandbox so cross-pod turns reattach), `loadgen-teardown.ts` (delete demo identities), `fake-turn.ts`, `ws-smoke.ts` (real Bun socket over `/ws`), `acceptance.ts` (paid, vs deployment), `cluster-proof.ts + cluster-proof-check.ts` (turn across pods + rolling-restart no-loss). |

`.env.example` documents every `VIBE_VR_*`; `env.ts` validates only what the API uses today (Zod).

---

## 4. `apps/napbench` — benchmark CLI (Playwright lives only here)

Shell around `@vibe-vr/bench` pure layer. Entry `scripts/napbench.ts`, `napbench-trial.ts` (harbor `run/verify`), `harbor-tasks.ts` (registry generator), `capture-corpus.ts`, `preview|vision-reachability.ts`.

`src/`: `trial.ts`, `harbor-task.ts`, `harness-identity.ts`, `results-dir.ts`, `write-report|screenshot.ts`, `load-report.ts`, `corpus-fixtures.ts`, `playwright-browser-session.ts`, `vision-judge.ts` (`OpenRouterVisionJudge`), `product-judge|rubric.ts`, `preview-spike.ts`, plus `*.test.ts` and `*.integration.test.ts` (`browser-driving`, `corpus-discrimination`, `playwright-browser-session`, `task-commands` — need `VIBE_VR_CHROME_PATH`, some `--real`).

`fixtures/corpus/<9 dirs>/`: `index.html + desktop.png + mobile.png` — nine hand-written apps with one shared Intent (`ai-slop-generic`, `broken-beautiful`, `correct-ugly`, `desktop-only-breaks-mobile`, `excessive-gradient`, `excessive-icon`, `icons-restrained`, `minimalist-professional`, `responsive-strong`). Re-photograph all-at-once via `napbench:corpus`.

---

## 5. `packages/` — 11 workspaces

Dependency rule (`test/architecture.ts` enforces both manifest + actual `@vibe-vr/*` imports): `runtime → {context, agent, sandbox, storage, capture, db, verify} → shared`. `bench` + `loadgen` sit beside `shared` (pure, ports only). `verify` sits below both `runtime` and `bench`. `runtime → bench` forbidden.

| Package | `src/` highlights |
|---|---|
| `shared` | Contract owner: `events.ts` (typed events + Zod), `ws-protocol.ts`, `projects-protocol.ts`, `files-protocol.ts`, `models-protocol.ts`, `job-state.ts` (`foldJobs`), `check-outcome.ts` (passed/failed/absent), `result.ts`, `shell.ts`, `logging.ts`, `event-identity.ts`, `capacity|lease-windows.ts`, `project-title.ts`, `version.ts`, `env-file.ts`, `ports/*.ts` (agent, runtime, llm, context, memory, sandbox-manager, sandbox-inventory, sandbox-capacity, page-capture, event-store/bus, project/session/snapshot/user-key stores, turn-queue, turn-rate-limit, object-store, capacity-reconciler, sweep-lock). `ports/types.test-d.ts` type tests. |
| `db` | Drizzle + PG: `schema.ts`, `client.ts`, `postgres-*.ts` (event-store, notify-event-bus + transport, turn-queue, turn-rate-limiter, session/project/project-sandbox/snapshot/sandbox-capacity stores, advisory-lock, capacity-reconciler, `purge-demo-users.ts`, `session-bootstrap.ts`, `event-notification.ts`, `event-tail-reader.ts`), `in-process-event-bus.ts`, `testing/` fakes (`in-memory-*` for every store + `enqueue-request`, `event-assertions`, `docker-postgres`, `postgres-container`, `global-setup.ts`), `drizzle/*.sql + meta/*` (0000–0007), `drizzle.config.ts`, `scripts/migrate.ts`. |
| `sandbox` | `e2b-sandbox-manager.ts`, `git.ts`, `project-files.ts`, `template.ts`, `testing/in-memory-sandbox-manager.ts + conformance.ts + script-git.ts`. `template/` = generated-app starter (Vite+React+Tailwind, shadcn `ui/*`, `AGENTS.md`, `index.css`, `lib/utils.ts`). `scripts/build-template.ts`. Integration tests need real E2B. |
| `storage` | `r2-object-store.ts` (+ integration test), `testing/in-memory-object-store.ts`. Bytes vs bookkeeping split. |
| `capture` | `chrome-page-capture.ts` (+ integration, needs Chrome), `bounded-page-capture.ts` (concurrency bound), `testing/fake-page-capture.ts`. Knows URL→PNG only. |
| `agent` | `agent-service.ts` (own loop, 6 tools proxy via `SandboxManager`), `tools/definitions|execute|diff.ts`, `claude-provider.ts`, `anthropic.ts`, `openrouter.ts`, `bedrock.ts`, `delta-stream.ts`, `safety/budget|commands.ts`, `testing/scripted-llm-provider|agent.ts`. `*.integration.test.ts` (`claude-provider`, `prompt-caching`) spend money. |
| `context` | `context-engine.ts` (budget + truncation ladder), `system-prompt.ts + __snapshots__/`, `tokens.ts`, `file-tree.ts`, `job-brief.ts` (`<job>` objective + failures), `noop-memory-provider.ts`, `testing/stub-context-engine|sandbox.ts`, `scripts/measure-audit-session.ts`. |
| `runtime` | Turn lifecycle: `single-agent-runtime.ts`, `acquire-sandbox.ts`, `turn-log|ging.ts`, `event-sink.ts`, `append-retry.ts`, `verify-turn.ts`, `repair-prompt|loop.ts`, `turn-thumbnail|apture.ts`, `continue-job|on-open.ts`, `job-lifecycle.ts`, `session-queue.ts` (in-process second line), `turn-worker.ts` (claim/renew/abort/drain), `reaper.ts`, `janitor.ts`, `reconcile-capacity.ts`, `teardown.ts`, `close|delete-project.ts`, `restore.ts`, `sweep-schedule.ts`, `harness.ts`, `testing/controllable-runtime.ts`, `scripts/harness.ts` (`bun run harness`). `*.integration.test.ts` (`full-cycle`, `restore`) are real. |
| `verify` | Shared primitive: `run-checks.ts`, `discover-checks.ts` (from project, cheapest-first), `command-output.ts` (tail-per-stream + truncation flag), `preview.ts` (probe). Used by Runtime *and* Bench. |
| `bench` | Pure benchmark: `suite.ts`, `task.ts`, `tasks/*.ts` (`todo-crud`, `landing-page`, `expense-ledger`, `reading-list`, `pricing-page`, `sales-dashboard`, `responsive-layout`, `template`, `tracer.ts`, `debug-broken.ts`), `runner.ts`, `browser-executor|session.ts`, `browser-check.ts`, `accessibility-check.ts`, `selector.ts`, `viewport.ts`, `visual.ts` (legacy), `product/*` (`grade|matrix|judgement|evaluation|dimension|corpus|discrimination|product-score.ts`), `category.ts`, `score.ts`, `scoring-model.ts` (v1/v2), `gates.ts`, `status.ts`, `error-kind.ts`, `metrics.ts`, `capture.ts`, `screenshot.ts`, `surface.ts`, `trajectory.ts`, `report.ts`, `results-dir.ts`, `reward.ts`, `run-configuration.ts`, `distribution.ts`, `comparison (compare.ts)`, `summary.ts`, `cli.ts`, `parse-failure.ts`, `pricing.ts`, `testing/scripted-*.ts + bench-report.ts`. |
| `loadgen` | Pure load: `journey.ts` (sign-in→project→socket→turn→`job.completed`), `calibration.ts` (fake latencies from funded runs), `percentiles.ts`, `metrics.ts`, `report.ts`, `degradation.ts`, `ramp-thresholds.ts`, `k6-summary.ts`, `sequence.ts`, `probes.ts`, `server|cluster-samples.ts`, `slow-ports.ts`, `shared-sandbox-manager.ts`, `worker-concurrency.ts`, `looping-llm-provider.ts`. |

Every `testing/` fake is exported production-quality code used downstream.

---

## 6. `harbor/` — Python adapter (invisible to Biome/tsc/vitest)

`napbench_harbor/agent.py` (Harbor `BaseAgent`, subprocess + bookkeeping), `napbench_harbor/trial.py` (stdlib-only decisions), `tests/test_agent|trial.py` (no-framework pytest), `pyproject.toml` (`uv`), `tasks/` generated+gitignored. Gates: `bun run lint:py (ruff)`, `bun run test:py`. Cross-language markers guarded TS-side in `harbor-agreement.test.ts`. See `harbor/README.md` + ADR-0014 (orchestrates only, scores nothing; `report/trajectory/trial.log` always, `reward.json` only if measured).

## 7. `infra/` — run it

* `docker-compose.yml` — local Postgres for `dev` + `db` suite.
* `k8s/base/` — `namespace|configmap|secret.example|deployment-api|deployment-worker|deployment-reaper|service-api|ingress-api|hpa-api|scaledobject-worker|networkpolicy|job-migrate|kustomization.yaml`. Probes `/livez|/readyz`, WS timeouts > heartbeat, HPA on `nap_ws_connections` + CPU, KEDA on queue depth capped by sandbox ceiling, reaper `Recreate`, gauge = `apps/api/src/metrics.ts`.
* `k8s/local/` — shared laptop overlay (fakes entrypoint, `Never` pull, in-cluster PG, localhost ingress).
* `k8s/proof/` — `kind-cluster|kustomization|patch-config|patch-remove-unsupported.yaml`, `run.sh`. Proves turn-across-pods + rolling-restart-no-loss via `cluster-proof.ts` + PG-backed fake sandbox.
* `k8s/load/` — + `monitoring.yaml` (KEDA, metrics-server, Prometheus), `patch-scale|patch-config|patch-remove-unsupported.yaml`, `kind-cluster.yaml`, `run.sh`, `kustomization.yaml`. 100-user ramp, results in `napload-results/`.

## 8. `docs/` — one fact, one place

`PLAN.md` (frozen v1 spec), `DEPLOY.md` (Railway/Vercel topology, 3 entrypoints, env list, 4 silent mistakes), `GOTCHAS.md` (read the section you touch), `NAPBENCH.md` (flags, suites, judges, scoring, authoring), `napbench-*.md` (funded runs: `first-real|first-product|verification-measurement|luna-remeasurement|vision-judge|corpus-margin` + `example-report.json`), `scaling-design|baseline|cluster.md` (queue semantics §21 invariants, k6 numbers, multi-pod comparison), `adr/0001–0014` (bench split, renormalise, unmeasurable-absent, model-measured, arrival-is-not-broken, turn-is-claim, check-below-both, transcript-derived, queue-not-broker, notify-then-read, stale-tool-traffic, geometric-halves, ordinal-product-judge, harbor-orchestrates), `agents/domain|issue-tracker|triage-labels.md`, `demo.gif`.

## 9. `test/` — repo-wide guards (run in `bun run test`)

`architecture.ts` (dep direction + manifest match + `@vibe-vr/bench` ban + new-package tombstone), `comments.ts` (no `M2-5` task IDs in `src`, cite reason/section), `docs.ts` (README vs `/docs` split, mechanism numbers only in docs), `k8s.ts` (manifest claims: metric name from code, ceiling↔scaler arithmetic, removals explicit), `railway.ts` (3 services, healthcheck only on API, reaper=1, no literal secrets, drain>app), `deploy-ignore.ts`, `template-design|checks.ts`, `project-root.ts`, `integration-setup.ts` (loads `.env` for Node under Vitest).

---

### Where to start by task

| Want to… | Open |
|---|---|
| Chat/preview UI | `apps/web/src/chat/transcript.ts`, `hooks/use-event-stream.ts`, `workspace/workbench.tsx`, `docs/*.tsx` |
| Admit/execute a turn | `apps/api/src/turns/routes.ts`, `turns/sandbox-quota.ts`, `packages/runtime/src/single-agent-runtime.ts`, `turn-worker.ts` |
| Change prompt/budget | `packages/context/src/context-engine.ts`, `system-prompt.ts`, `job-brief.ts` |
| Change tools/model | `packages/agent/src/agent-service.ts`, `tools/`, `claude-provider|openrouter|bedrock.ts` |
| Change verification | `packages/verify/src/run-checks.ts`, `discover-checks.ts` |
| Change persistence/fanout | `packages/db/src/postgres-event-store.ts`, `postgres-notify-event-bus.ts`, `postgres-turn-queue.ts` |
| Add benchmark task | `packages/bench/src/tasks/`, `docs/NAPBENCH.md`, ADR-0001/0007 |
| Load/scale | `packages/loadgen/src/journey.ts`, `apps/api/k6/ramp.js`, `docs/scaling-design.md`, `infra/k8s/README.md` |
| Deploy | `docs/DEPLOY.md`, `.railway/railway.ts`, `Dockerfile`, `infra/k8s/base/` |
| External harness | `harbor/`, `harbor/README.md`, `apps/napbench/scripts/napbench-trial.ts` |
