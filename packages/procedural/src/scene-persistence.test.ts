/**
 * Scene log persistence round-trip: file store to the viewport boundary.
 *
 * Production keeps scene state in the event log and the viewport rebuilds from
 * replayed events; the Postgres transport behind that log needs a database this
 * environment does not have. This test keeps the durable half honest instead:
 * real `scene.updated` and `scene.rejected` stored events cross a genuine
 * filesystem boundary through FileObjectStore, and a fresh store instance with
 * no memory shared with the writer reads them back, re-validates, folds and
 * rebuilds. Reconstruction ends at the same functions the viewport calls.
 *
 * What this does not prove: the Postgres EventStore transport and R2. Every
 * persisted entry re-parses as a NapEvent on the way back, so the only
 * substitution is the medium — and JSON round-trip survival is an explicit
 * guarantee of the event contract, not an assumption smuggled in here.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "@vibe-vr/scene-spec/canonical";
import { collectSceneChain } from "@vibe-vr/scene-spec/fold";
import { validateProposal } from "@vibe-vr/scene-spec/proposal";
import { createChildRevision, createGenesisRevision } from "@vibe-vr/scene-spec/revisions";
import { readSceneHead, sceneLogEvents } from "@vibe-vr/scene-spec/scene-events";
import type { SceneSpec } from "@vibe-vr/scene-spec/schema";
import { TOWER_BASE_ID, TOWER_MID_ID, TOWER_TOP_ID, towerSpec } from "@vibe-vr/scene-spec/tower";
import { NapEventSchema } from "@vibe-vr/shared/events";
import type { StoredEvent } from "@vibe-vr/shared/ports/event-store";
import { FileObjectStore } from "@vibe-vr/storage/file-object-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildScene } from "./build.ts";
import { boundsMatch, objectBounds } from "./export.ts";
import { builtSceneToGroup, disposeGroup } from "./three-adapter.ts";

const SCENE_ID = "m5-integration-scene";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TURN_GENESIS = "22222222-2222-4222-8222-222222222222";
const TURN_EDIT = "33333333-3333-4333-8333-333333333333";
const TURN_INVALID = "44444444-4444-4444-8444-444444444444";
const CREATED_AT = "2026-10-04T00:00:00.000Z";
const LOG_KEY = `scenes/${SCENE_ID}/log.json`;
/** Base width after the +20% edit: 2m becomes 2.4m. */
const WIDENED_BASE_M = 2.4;
/** Total tower height is unchanged by the width edit. */
const TOWER_HEIGHT_M = 4;

function sceneUpdated(
  seq: number,
  turnId: string,
  spec: unknown,
  parentHash: string | null,
  specHash: string,
): StoredEvent {
  return {
    sessionId: SESSION_ID,
    turnId,
    seq,
    createdAt: CREATED_AT,
    type: "scene.updated",
    payload: { spec, parentHash, specHash },
  };
}

/**
 * Genesis plus one widening edit through the typed proposal API — the same
 * validation the model and the inspector both pass through.
 */
function acceptGenesisAndWidenedEdit(): {
  genesisSpec: SceneSpec;
  genesisHash: string;
  childSpec: SceneSpec;
  childHash: string;
} {
  const created = validateProposal({ spec: towerSpec(), rationale: "M5 genesis tower." }, null);
  if (!created.ok) throw new Error(`genesis proposal refused: ${created.error.message}`);
  const genesis = createGenesisRevision({
    sceneId: SCENE_ID,
    spec: created.value.spec,
    author: { kind: "user", label: "m5" },
  });
  if (!genesis.ok) throw new Error(`genesis revision refused: ${genesis.error.message}`);

  const edited = validateProposal(
    {
      baseHash: genesis.value.specHash,
      ops: [{ op: "set_param", nodeId: TOWER_BASE_ID, key: "width", value: WIDENED_BASE_M }],
      rationale: "M5 widen the base by twenty percent.",
    },
    genesis.value.spec,
  );
  if (!edited.ok) throw new Error(`edit proposal refused: ${edited.error.message}`);
  const child = createChildRevision({
    sceneId: SCENE_ID,
    parent: genesis.value,
    spec: edited.value.spec,
    author: { kind: "user", label: "m5" },
  });
  if (!child.ok) throw new Error(`child revision refused: ${child.error.message}`);

  return {
    genesisSpec: genesis.value.spec,
    genesisHash: genesis.value.specHash,
    childSpec: child.value.spec,
    childHash: child.value.specHash,
  };
}

async function persistLog(dir: string, events: StoredEvent[]): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(events));
  expect((await new FileObjectStore(dir).put(LOG_KEY, bytes)).ok).toBe(true);
}

/**
 * Read through a new store instance over the same directory. FileObjectStore
 * keeps no cache, so nothing written above is reachable except through bytes
 * on disk — the closest this environment gets to a fresh process.
 */
async function readLogFresh(dir: string): Promise<StoredEvent[]> {
  const read = await new FileObjectStore(dir).get(LOG_KEY);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error("scene log missing after persist");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(read.value));
  expect(Array.isArray(parsed)).toBe(true);
  const events: StoredEvent[] = [];
  for (const entry of parsed as unknown[]) {
    const validated = NapEventSchema.safeParse(entry);
    expect(validated.success).toBe(true);
    if (!validated.success) throw new Error("persisted entry is not a contract event");
    events.push(validated.data);
  }
  return events;
}

describe("scene log persistence to the viewport boundary", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nap-scene-m5-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists an accepted genesis plus edit and rebuilds the viewport scene from a fresh read", async () => {
    const { genesisHash, childSpec, childHash } = acceptGenesisAndWidenedEdit();
    const genesisSpec = towerSpec();
    const events: StoredEvent[] = [
      sceneUpdated(0, TURN_GENESIS, genesisSpec, null, genesisHash),
      sceneUpdated(1, TURN_EDIT, childSpec, genesisHash, childHash),
    ];

    // The writer side builds first, so the fresh read has something to agree with.
    const before = buildScene(childSpec);
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error("writer-side build failed");

    await persistLog(dir, events);
    const reread = await readLogFresh(dir);

    const head = readSceneHead(reread);
    expect(head?.hash).toBe(childHash);
    if (head === null) throw new Error("fresh fold found no scene head");
    // Byte-identical canonical form: the rebuild depends on persisted data only.
    expect(canonicalize(head.spec)).toBe(canonicalize(childSpec));

    const chain = collectSceneChain(sceneLogEvents(reread));
    expect(chain).toHaveLength(2);
    const [first, second] = chain;
    expect(first?.parentHash).toBeNull();
    expect(first?.hash).toBe(genesisHash);
    expect(second?.parentHash).toBe(genesisHash);
    expect(second?.hash).toBe(childHash);

    const rebuilt = buildScene(head.spec);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) throw new Error("fresh-side build failed");
    expect(rebuilt.value.triangleCount).toBe(before.value.triangleCount);
    expect(boundsMatch(rebuilt.value.bounds, before.value.bounds)).toBe(true);
    expect(rebuilt.value.bounds.min[0]).toBeCloseTo(-WIDENED_BASE_M / 2);
    expect(rebuilt.value.bounds.max[1]).toBeCloseTo(TOWER_HEIGHT_M);

    const group = builtSceneToGroup(rebuilt.value);
    try {
      expect(group.name).toBe("vibe-vr-scene");
      expect(group.children).toHaveLength(3);
      const nodeIds = group.children.map((child) => child.name).sort();
      expect(nodeIds).toEqual([TOWER_BASE_ID, TOWER_MID_ID, TOWER_TOP_ID].sort());
      expect(boundsMatch(objectBounds(group), rebuilt.value.bounds)).toBe(true);
    } finally {
      disposeGroup(group);
    }
  });

  it("skips a tampered update and a rejection persisted beside valid entries", async () => {
    const { genesisSpec, genesisHash, childSpec, childHash } = acceptGenesisAndWidenedEdit();
    // Schema-valid transport, forged content hash: the fold must refuse it, and
    // the refusal proves nothing about the transport, which parses cleanly.
    const tampered = sceneUpdated(1, TURN_INVALID, childSpec, genesisHash, "0".repeat(64));
    const rejected: StoredEvent = {
      sessionId: SESSION_ID,
      turnId: TURN_INVALID,
      seq: 2,
      createdAt: CREATED_AT,
      type: "scene.rejected",
      payload: { code: "stale_base", diagnostics: "M5 stale edit refused." },
    };
    const events: StoredEvent[] = [
      sceneUpdated(0, TURN_GENESIS, genesisSpec, null, genesisHash),
      tampered,
      rejected,
      sceneUpdated(3, TURN_EDIT, childSpec, genesisHash, childHash),
    ];

    await persistLog(dir, events);
    const reread = await readLogFresh(dir);

    const head = readSceneHead(reread);
    expect(head?.hash).toBe(childHash);
    if (head === null) throw new Error("fresh fold found no scene head");
    expect(canonicalize(head.spec)).toBe(canonicalize(childSpec));
    // Two accepted entries: genesis and the valid edit. The tampered entry and
    // the rejection left no revision behind and moved no head.
    expect(collectSceneChain(sceneLogEvents(reread))).toHaveLength(2);
  });
});
