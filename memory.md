# Memory — Vibe-VR Phase 1 + local dev + UI consistency

Last updated: 2026-10-08 (UTC). Branch `main` @ `9b630af`. Work uncommitted (`apps/api/src/boot.ts` only).

## What was built

**Vibe-VR Phase 1 slice** (deterministic procedural 3D editor, no AI/GPU/E2B/DB):
- `packages/scene-spec/` (new): versioned Zod SceneSpec (box/cylinder/group, TRS, materials), canonical serialization, vendored sync SHA-256, atomic patches (≤64 ops, stale-base reject), immutable parent-linked revisions + undo/redo, v1 migration registry, shared tower fixture. Tower golden hash `b3534b9a…` (canonical length 997).
- `packages/procedural/` (new): pure-TS engine (exact boxes, trig cylinders, Three.js-matching column-major matrices, baked world verts, 500k-tri budget), `three-adapter.ts`, `export.ts` (real GLTFExporter→GLB→GLTFLoader→bounds compare, 1e-4 m tolerance).
- `apps/web/src/viewport/` (new): 3D Model workbench tab — canvas w/ orbit/lights/grid, scene tree, width inspector, revision history + undo/redo, GLB export + download, in-memory revisions. Selection commits on click (down+up <5px, primary button), not pointerdown.
- Wiring: `tabs.ts` + `workbench.tsx` + `app-shell.tsx` gain third face; `test/architecture.ts` + roster updated. Deps: `three@0.186.1` pinned in procedural + web, `@types/three` devDeps.
- **UI consistency track + `ui-registry.md`** (new, repo root): baseline, P1/P2/P3 applied, exceptions E1/E1b/E2/E3. Applied: 11× `rounded-[5/6/8/9px]`→`rounded-chip`; 5 `--color-syntax-*` tokens in `globals.css` + `file-viewer.tsx` THEME via `var()` (emission verified by compiling the stylesheet); send button gained `enabled:hover:bg-white` to match Resume; selection emissive `0x2a5cff`→`0x7c5cff`.
- **`VIBE_VR_OBJECT_STORE=local` escape hatch** (no R2 account needed locally): `packages/storage/src/file-object-store.ts` + tests (traversal-safe, R2-identical error semantics); `env.ts` (`VIBE_VR_OBJECT_STORE: r2|local` default r2, `VIBE_VR_OBJECT_STORE_DIR` default `.nap-objects`, R2 keys required only on r2); `boot.ts` branch; `.env.example` docs; `.nap-objects/` added to `.gitignore`.
- User confirmed the 3D Model tab renders live at `/p/[projectId]` (SSR contains `workbench-tab-model`; earlier "no visible difference" was navigation — tab lives only in project workspaces, behind sign-in).

**Live verification, 2026-10-08 (Luna via OpenRouter, E2B, Neon):**
- Model: `openai/gpt-5.6-luna` at `medium` effort, `VIBE_VR_PLATFORM=openrouter`. Debug on Luna, record on Opus.
- `bun run harness --real "add a dark mode toggle"` green: 3 reads → 4 edits → `npm run build` passed in-sandbox, `turn.completed` 42k in / 2.2k out, verification passed, `job.completed verified`, commit `8923ee8`.
- E2B template `nap-vite-react` was 404 under the user's new E2B key (templates are per-account); fixed with `bun run template:build` in `packages/sandbox`.
- Postgres on Neon: `DATABASE_URL` (pooler) + `VIBE_VR_LISTEN_DATABASE_URL` (direct host, no `-pooler` — `LISTEN` fails over pooled connections). `bun run db:migrate` → "Migrations applied."
- `bun run dev:worker` refused with `VIBE_VR_EVENT_BUS=in-process`; fixed with `VIBE_VR_EVENT_BUS=postgres` (separate API+worker needs Postgres fanout).
- UI turn failed on OpenRouter reserving the full 64k `max_tokens` ceiling (key affords 29,350); fixed in `apps/api/src/boot.ts:233` — provider now sends `maxTokens: 16_000` on all three platform branches (harness already used 8k). Typecheck clean. **Uncommitted.**
- User confirmed live UI 3D loop: stool generated from chat prompt in Model tab, then edited via chat — `scene.updated` → viewport both times.

## Decisions made

- procedural core has zero three imports; adapter isolated in `three-adapter.ts`.
- Revisions in-memory (persistence deferred); undo = head-pointer move.
- GLB round-trip runs in Node via minimal `FileReader` test shim (exporter genuinely executes).
- `local` store is dev-only, never default; production keeps failing closed without R2. No `!` (explicit unreachable-throw in boot).
- `ui-registry.md` is the UI consistency reference.
- Repo-wide `bun run lint` red is pre-existing (CRLF checkout); only touched-file cleanliness enforced.
- API `maxTokens` 16k (not 64k default): OpenRouter admits against the ceiling, so the default reserves more than a low-balance key holds. Harness stays at 8k.

## Problems solved

- Zod `discriminatedUnion` needs unique discriminators → two-level union.
- three r186 ships no types → `@types/three`; GLTFExporter needs FileReader → test shim; jsdom lacks `setPointerCapture`/`createObjectURL` → test shims.
- Box/cap winding was inward → fixed, signed-volume test incl. cylinders.
- Review I-1 (blur double-commit) → `setWidth` dirty check; drag-clears-selection → click-gesture pick + 4 gesture tests.
- Web test pool times out under parallel load → `--maxWorkers=1` for web runs.
- `bun run db:migrate` failing despite `.env` set → empty `DATABASE_URL` persisted in Windows env shadows the file (loader: already-exported wins). Fix: remove persisted var or prefix the command.
- Anonymous sign-in 500 `relation "users" does not exist` → dev DB never migrated; `bun run db:migrate` is the documented missing step (README order).
- User pasted live E2B/OpenRouter/secret + Neon values into chat → told to rotate all of them (2026-10-04 and again 2026-10-08).
- No `docker` binary on this machine → `db` suite unrunnable; dev DB via Neon instead of compose.

## Current state

- `typecheck` green on `apps/api` after `boot.ts` edit; full `test:fast` not re-run since.
- Live stack: Neon migrated, `dev` + `dev:worker` up, Luna turns + 3D chat generation/edit verified in UI.
- Tree: only `apps/api/src/boot.ts` modified. `apps/api/.env` (Neon, E2B, OpenRouter, generated secrets, `VIBE_VR_EVENT_BUS=postgres`) is gitignored by design.
- Prior Phase-1 work described above is committed; `REPO_MAP.md` pre-existing untracked, not ours.

## Next session starts with

- `git status` first; decide on committing `feat(api): cap provider maxTokens at 16k` (typecheck green, rationale in boot comment).
- Re-run `test:fast` + `typecheck` after any further edits.
- Then Phase 2 (constrained agent tools, conversational edits, persisted revisions, geometry verification) or production hardening.

## Open questions

- Did the user rotate the exposed keys (E2B, OpenRouter, Neon, auth secrets)? (Asked twice, unconfirmed.)
- Phase 2+ deferrals unchanged: backend authoritative build, Blender adapter, GPU inference + model benchmark, R3F.
- Should `maxTokens` become `VIBE_VR_MAX_OUTPUT_TOKENS` env instead of hardcoded 16k? Deferred — hardcoded until a second value is needed.
