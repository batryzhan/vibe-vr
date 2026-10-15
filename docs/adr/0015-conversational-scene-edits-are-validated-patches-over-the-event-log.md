# ADR-0015 — Conversational scene edits are validated patches over the event log

**Status:** Proposed — 2026-10-04. Awaiting approval of the M0 decision record before M1.

## Context

Phase 1 built a deterministic scene pipeline (`packages/scene-spec`,
`packages/procedural`, `apps/web/src/viewport/`) that is fully disconnected
from Nap: the agent has six code tools and zero scene knowledge
(`packages/agent/src` contains no scene/procedural/patch references), the event
union has seventeen types and zero scene types (`packages/shared/src/events.ts`),
no scene tables exist, and the viewport holds its `RevisionLog` in a React ref
with no session, socket, or API reference. The approved next milestone is one
conversational edit end to end — *"make the base 20% wider"* in chat widening
the tower — with no new tables, no new queue, no GPU, and no new package. This
record fixes the contracts that milestone will implement, so M1–M3 have frozen
names to code against.

## Decision

A conversational scene edit is a validated patch proposed by the model,
appended to the existing event log, and folded back into scene state by every
reader from the same log. Five sub-decisions follow; each cites the mechanism
that already exists.

### 1. The `SceneProposal` contract

The model may emit exactly one geometry-bearing shape (new, owned by
`packages/scene-spec`, alongside `SceneSpecSchema` at `schema.ts:134`):

- `baseHash`: the canonical content hash the proposal was computed against.
- `ops`: the closed `PatchOp` vocabulary `applyPatch` already accepts
  (`packages/scene-spec/src/patch.ts:105`) — no new operation kinds in this slice.
- `rationale`: short human-readable text for the transcript; never executed.

Anything outside this shape is not a proposal the system can act on. Invalid
proposals are unrepresentable past validation, not "handled" — the same rule
that makes `executeTool` refuse unknown tool names rather than log them
(`packages/agent/src/tools/execute.ts:64-72`).

### 2. Additive scene event types

Three types join the `NapEvent` union in `packages/shared/src/events.ts`,
following its existing `{ type, payload }` style:

- `scene.updated { spec, parentHash, specHash, turnId }` — a validated patch
  applied; `spec` is KB-scale JSON, never mesh bytes.
- `scene.rejected { diagnostics, turnId }` — validation refused the proposal;
  `diagnostics` is machine-usable (unknown node, stale base with expected vs
  actual hash, out-of-range parameter) so the model can correct itself.
- `scene.reverted { toHash, turnId }` — undo. History stays append-only; no
  event is ever mutated, matching the log's existing immutability.

No existing type changes shape. Old web clients tolerate the additions: the
stream parser drops what does not parse (`use-event-stream.ts:187-188` returns
`undefined` on `safeParse` failure), so a pre-slice browser ignores scene
frames instead of breaking. API and worker ship in one image, so no mixed-
version readers exist server-side.

### 3. Event-folded scene state, no new tables

Current scene state is `foldSceneSpec(events)`, a pure function in
`packages/scene-spec` beside `foldJobs` (`packages/shared/src/job-state.ts:153`),
returning the head spec or null. No migrations, no new tables: `events.payload`
is already `jsonb` typed as `NapEvent["payload"]` (`packages/db/src/schema.ts:236`),
and the store parses rows against the union on read
(`postgres-event-store.ts:24-45`), so extended variants flow through unchanged
code. A future `scene_revisions` table (M5) remains a query optimization, not a
correctness requirement — the log is the authority either way.

### 4. Two agent tools, in the existing six-tool pattern

`get_scene` (reads the folded head; returns ids, names, params, hashes — never
mesh data) and `propose_scene_patch` (runs `validateSceneSpec` + `applyPatch`
in-process in the worker) extend `agent/tools/definitions.ts:78` and
`execute.ts`, following the per-arm-schema rule already documented there. The
"six real names" comment at `execute.ts:64` is updated, not worked around.
Geometry executes as pure TypeScript in the worker process — never
model-authored code, never a shell, never the sandbox. Per-turn model budgets
and quotas apply unchanged: a patch turn bills like any turn.

### 5. One validated patch path for AI and inspector edits

Inspector edits and agent proposals converge on `applyPatch`. The viewport
keeps its dirty check (no-op edits append nothing), and the worker path gets
the same guard: a patch whose ops change nothing is rejected as a no-op rather
than appended as an empty revision. Two writers, one function, one rule — which
is what keeps the "reapplying the same state produces the same hash"
property intact across both.

## Commit-boundary semantics (verified, not assumed)

Appending a scene event is **not** atomic with settling the turn, and the
design does not need it to be. The verified ordering is:

1. Tool results flow through `onEvent: sink.emit` (`single-agent-runtime.ts:827`)
   into the chained append-then-publish pipeline (`event-sink.ts:84-100`):
   emission order preserved, publish only after that event's append returns,
   first failure stops the chain.
2. `#attempt` drains the sink before reading the terminal outcome
   (`single-agent-runtime.ts:837-845`): when the turn ends, every emitted
   event — including `scene.updated` / `scene.rejected` — is durable.
3. The worker settles the `turn_requests` row **after** `execute()` returns,
   conditional on still holding the lease (`turn-worker.ts:209-219`).

Consequences, each load-bearing for the slice:

- **Durability point is `sink.drain()`, not settle.** A `scene.updated` visible
  in the log is durable even if the subsequent settle fails (lease lost); the
  row then belongs to the janitor while the scene stands. Viewport rendering
  must therefore key off log presence, never row state.
- **Crash between drain and settle duplicates nothing.** A retried append
  carries the seq watermark and the store dedupes under its serialization lock
  (`postgres-event-store.ts:78-91`, `AppendOptions.retryAfterSeq` at
  `ports/event-store.ts:31-46`); the fold is idempotent over duplicates by
  content hash.
- **Lease loss mid-turn aborts before append.** Renewal returning `held: false`
  aborts the turn (`turn-worker.ts:20-30`), so a worker that lost its lease
  cannot append a scene event another worker would then share a session with.
  No cross-worker scene fork is reachable through this path.

## Atomicity, ordering, replay, undo

- **Atomicity:** `applyPatch` clones-then-validates (existing behavior); the
  log append is a single serialized statement per event (existing store
  guarantee). A failed patch appends `scene.rejected`, never a partial scene.
- **Stale base:** the proposal's `baseHash` is checked against the folded head
  inside the worker before append. Mismatch → `scene.rejected` naming expected
  vs actual; the model re-reads via `get_scene` and retries under the existing
  bounded-retry policy.
- **Ordering:** per-session `seq` is gapless under the store's serialization
  (`postgres-event-store.ts:4-16`); the fold reads in `seq` order, so concurrent
  editors serialize into one history. One lease per session means only the
  lease-holding worker appends scene events — the inspector's own edits travel
  as proposals through a turn in this slice, never as direct appends.
- **Reconnect replay:** unchanged mechanics — WS resume from `seq`, full log
  refold on the client. A reconnecting viewport rebuilds byte-identical history
  because revisions derive from content hashes, not from session memory.
- **Undo:** `scene.reverted { toHash }`; the fold resolves the head to the
  referenced revision. Redo, if ever wanted, is a second pointer event, not a
  mutation — out of scope for the slice.

## Scoping and authorization

Scene events carry `sessionId` like every event (the store assigns `seq`;
emitters never invent it — `execute.ts:11-16`, `ports/event-store.ts:4-14`).
Project identity derives from the session exactly as chat events do today
(`owned-session.ts` pattern at the route layer); no new auth layer, no new
ownership table. Admission-time checks (user, quotas, model access) already run
before the worker starts, so a patch turn is authorized the same way as the
chat turn carrying it. Per-user spend is bounded by the same turn quotas —
there is deliberately no separate GPU-style budget because there is no GPU
work in this slice.

## Acceptance criteria for the first slice

- Unit: proposal schema accept/reject matrix; fold over empty, single,
  out-of-order-duplicate, and revert event sequences; no-op patch rejection.
- Integration (scripted model, no paid calls): *"make the base 20% wider"* →
  one `scene.updated` event, folded head bounds `x ∈ [-1.2, 1.2]`, prior
  revision intact; invalid prompt (unknown node, out-of-range width) →
  `scene.rejected` with named diagnostics and unchanged head.
- Web: viewport derives revisions from a synthetic session log (applies
  `scene.updated`, ignores `scene.rejected`, rebuilds identical history on
  replay-from-zero); `test/architecture.ts` green (no new package, no new
  `@vibe-vr/*` edges beyond the two tool arms' existing imports).
- Gates: `bun run test:fast`, `bun run typecheck`, `biome check` on touched
  files — plus the repo's Definition of Done rule that each new guard is seen
  to fail (break the stale-base check, watch the rejection test go red, revert).

## Unresolved questions (for review, not implementation)

1. **Event names:** are `scene.updated` / `scene.rejected` / `scene.reverted`
   the right three, or should rejection ride the existing `tool.result`
   (`ok: false`) with `scene.updated` as the sole new type? Leaning three
   types: the fold, the transcript, and the model's retry logic all read them
   distinctly, and stuffing scene semantics into a free-text tool output
   forfeits exactly the machine-usability `diagnostics` exists for.
2. **Spec-in-event size ceiling:** tower specs are KBs. If a future scene
   approaches WS frame or row sanity limits, specs move to object storage with
   the event carrying `{ specHash, artifactRef }` — same shape as snapshot
   handling today. No action now; the fold signature should take bytes-or-ref
   from the start to avoid a second migration of readers.
3. **Inspector transport:** the slice routes inspector edits as proposals
   through a turn (one path, one rule). If that latency proves unusable for
   slider-drag edits, the alternative is optimistic local revisions reconciled
   against the log — explicitly deferred, not designed here.
4. **Viewport subscription mechanics:** which existing hook (`useSessionLog`
    vs a scene-specific selector over the same WS) owns the fold — M3
    implementation detail, named here so it is not mistaken for settled.

## Addendum — observed undo/redo semantics (M4 verification pass)

Inspected directly, pinned by tests, no behavior changed:

1. **Undo parking on shared state prunes the overlay.** `pruneOverlayToHead`
   (`apps/web/src/viewport/use-scene-revisions.ts`) drops the recorded overlay
   operations when the head returns to a shared revision. The revisions stay in
   the log object, so local redo still displays the parked edit — but the
   recorded operations are what future syncs replay, so the next remote advance
   rebuilds from the shared chain without it. **Redo cannot restore operations
   a sync has shelved.** Pinned by `use-scene-sync.test.tsx` ("undo to shared
   state prunes the overlay; a later remote advance does not resurrect it"),
   with the positive control beside it ("keeps local inspector edits across
   remote sync", no undo taken, edit replayed).
2. **Branch redo follows the first-inserted child.** `RevisionLog.redo`
   (`packages/scene-spec/src/revisions.ts`) scans insertion order, so an
   undo-then-edit that shelves the first child without deleting it leaves redo
   deterministically returning the older sibling, while `history()` lists only
   the chosen lineage. Pinned by `revisions.test.ts` ("redo on a branch follows
   the first-inserted child").
3. **Unresolved, recorded not decided:** shelving is silent — no notice
   distinguishes "parked locally until the next sync" from "dropped", and a
   branched log offers no sibling choice. Whether the product should warn,
   offer branch choice, or keep the current behavior is open. The tests above
   pin what is, not what should be.
