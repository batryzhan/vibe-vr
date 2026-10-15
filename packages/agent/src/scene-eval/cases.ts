/**
 * Scene-proposal evaluation cases: fixed prompts, authored model traffic, and
 * explicit semantic acceptance criteria.
 *
 * The question under evaluation is whether a model turns natural-language 3D
 * requests into valid proposals for useful scenes — not whether the pipeline
 * works, which the unit suites already pin. Each case therefore separates two
 * verdicts that must never be conflated:
 *
 * - correctness: the traffic parses, validates, folds, and rebuilds;
 * - quality: the resulting spec carries the requested semantic change, stated
 *   in numbers (ratios, positions, colors) rather than impressions.
 *
 * The traffic here is authored in the exact shape a model turn emits — tool
 * names with tool inputs — so the offline run exercises the real tool,
 * validation, fold, and build path with no network. A live run replaces the
 * authored traffic with model output and reuses the same checks; nothing about
 * a check depends on where the traffic came from.
 *
 * Renderer-independent on purpose: every check reads the SceneSpec, never
 * pixels. What the viewport shows follows from the built geometry, which the
 * build step of the run already proves.
 */

import type { SceneNode, SceneSpec } from "@vibe-vr/scene-spec/schema";

export const DESK_SCENE_ID = "eval-desk";
export const DESK_TOP_ID = "top";
export const DESK_LEG_IDS = ["leg-fl", "leg-fr", "leg-bl", "leg-br"] as const;
export const DESK_LAMP_ID = "lamp";
export const DESK_MONITOR_ID = "monitor";
export const DESK_OAK_ID = "oak";
export const DESK_WALNUT_ID = "walnut";

const OAK = "#C8A165";
const WALNUT = "#5C4033";

/** One model turn's traffic: tool name plus the input it carried. */
export type ModelTraffic = {
  name: string;
  input: Record<string, unknown>;
};

/** A single numbered semantic assertion with its measured values. */
export type SemanticCheck = {
  name: string;
  pass: boolean;
  detail: string;
};

/**
 * One evaluation case: the prompt, the traffic that answers it, the spec the
 * traffic applies to, and the checks on the result. `traffic` takes the live
 * head hash so fixtures cite a real base without hardcoding one.
 */
export type EvalCase = {
  id: string;
  title: string;
  prompt: string;
  /** Whether the traffic is expected to change the scene. */
  kind: "genesis" | "edit" | "refused";
  baseSpec: () => SceneSpec | null;
  traffic: (baseHash: string | null) => ModelTraffic[];
  check: (before: SceneSpec | null, after: SceneSpec | null) => SemanticCheck[];
};

/** The shared starting point: a five-piece oak desk, top flush on four legs. */
export function makeDeskGenesis(): SceneSpec {
  const leg = (id: string, name: string, x: number, z: number): SceneNode => ({
    kind: "procedural",
    id,
    name,
    transform: { position: [x, 0.375, z], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    op: "box",
    params: { width: 0.07, height: 0.75, depth: 0.07 },
    seed: 7,
    materialId: DESK_OAK_ID,
  });
  return {
    version: 1,
    id: "00000000-0000-4000-8000-0000000000d1",
    seed: 7,
    units: "m",
    axes: "y-up",
    materials: [
      { id: DESK_OAK_ID, name: "Oak", color: OAK, metalness: 0, roughness: 0.7 },
      { id: DESK_WALNUT_ID, name: "Walnut", color: WALNUT, metalness: 0, roughness: 0.55 },
      { id: "glass", name: "Glass", color: "#1A1D21", metalness: 0.1, roughness: 0.2 },
    ],
    nodes: [
      {
        kind: "group",
        id: "desk",
        name: "Desk",
        transform: {
          position: [0, 0, 0],
          rotationEuler: [0, 0, 0],
          scale: [1, 1, 1],
        },
        children: [DESK_TOP_ID, ...DESK_LEG_IDS],
      },
      {
        kind: "procedural",
        id: DESK_TOP_ID,
        name: "Desktop",
        transform: { position: [0, 0.78, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        op: "box",
        params: { width: 1.6, height: 0.06, depth: 0.8 },
        seed: 7,
        materialId: DESK_OAK_ID,
      },
      leg(DESK_LEG_IDS[0] ?? "leg-fl", "Leg FL", -0.73, -0.33),
      leg(DESK_LEG_IDS[1] ?? "leg-fr", "Leg FR", -0.73, 0.33),
      leg(DESK_LEG_IDS[2] ?? "leg-bl", "Leg BL", 0.73, -0.33),
      leg(DESK_LEG_IDS[3] ?? "leg-br", "Leg BR", 0.73, 0.33),
    ],
    root: "desk",
  };
}

export function findNode(spec: SceneSpec, id: string): SceneNode | undefined {
  return spec.nodes.find((node) => node.id === id);
}

function boxNode(spec: SceneSpec, id: string): Extract<SceneNode, { op: "box" }> | undefined {
  const node = findNode(spec, id);
  if (node?.kind === "procedural" && node.op === "box") return node;
  return undefined;
}

/** Top surface height of the desk top, read from the spec rather than assumed. */
export function deskTopSurfaceY(spec: SceneSpec): number | undefined {
  const top = boxNode(spec, DESK_TOP_ID);
  if (top === undefined) return undefined;
  return top.transform.position[1] + top.params.height / 2;
}

/** Approximate relative luminance of a #rrggbb color, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function materialColor(spec: SceneSpec, id: string): string | undefined {
  return spec.materials.find((material) => material.id === id)?.color;
}

function ratioCheck(
  name: string,
  actual: number,
  expected: number,
  tolerance: number,
): SemanticCheck {
  return {
    name,
    pass: Math.abs(actual - expected) <= tolerance,
    detail: `measured ${actual.toFixed(4)}, expected ${expected.toFixed(4)} ± ${tolerance}`,
  };
}

/**
 * One case's result row. Both the offline fixture run and the live-model run
 * produce these, so a live trajectory can be compared against the fixture
 * baseline field for field. `model` names the source: "fixture" offline, the
 * model id for a live run.
 */
export type CaseReport = {
  caseId: string;
  kind: EvalCase["kind"];
  prompt: string;
  model: string;
  toolCalls: { name: string; ok: boolean }[];
  /** The propose input parsed as a scene proposal (schema gate). */
  parses: boolean;
  /** The proposal was accepted and emitted as scene.updated. */
  accepted: boolean;
  rejectionCode: string | null;
  headBefore: string | null;
  headAfter: string | null;
  /** The final head built into geometry without error. */
  reconstructed: boolean;
  checks: SemanticCheck[];
  /** Model completions consumed (fixture traffic counts one per tool call batch). */
  turns: number;
  /** Error or refusal tool results the model had to work around. */
  retries: number;
  usage: { inputTokens: number; outputTokens: number };
};

export type EvalMetrics = {
  cases: number;
  /** Genesis plus edit cases: proposals that must be accepted. Null when empty. */
  validityRate: number | null;
  /** Propose inputs passing the proposal schema, over all propose inputs. */
  schemaRate: number | null;
  /** Accepted heads that rebuild, over accepted heads. */
  reconstructionRate: number | null;
  /** Edit cases whose head hash moved, over edit cases. */
  editSuccessRate: number | null;
  /** Refused cases leaving the head unmoved, over refused cases. */
  rejectionRate: number | null;
  totalTurns: number;
  totalRetries: number;
  inputTokens: number;
  outputTokens: number;
};

/** Aggregate rates over case rows. Empty groups score null, never zero. */
export function summarize(reports: readonly CaseReport[]): EvalMetrics {
  const rate = (pass: number, total: number): number | null => (total === 0 ? null : pass / total);
  const valid = reports.filter((report) => report.kind !== "refused");
  const edits = reports.filter((report) => report.kind === "edit");
  const refused = reports.filter((report) => report.kind === "refused");
  const proposed = reports.filter((report) =>
    report.toolCalls.some((call) => call.name === "propose_scene_patch"),
  );
  const accepted = reports.filter((report) => report.accepted);
  return {
    cases: reports.length,
    validityRate: rate(valid.filter((report) => report.accepted).length, valid.length),
    schemaRate: rate(proposed.filter((report) => report.parses).length, proposed.length),
    reconstructionRate: rate(
      accepted.filter((report) => report.reconstructed).length,
      accepted.length,
    ),
    editSuccessRate: rate(
      edits.filter(
        (report) =>
          report.accepted && report.headBefore !== null && report.headAfter !== report.headBefore,
      ).length,
      edits.length,
    ),
    rejectionRate: rate(
      refused.filter(
        (report) =>
          !report.accepted &&
          report.headBefore === report.headAfter &&
          report.rejectionCode !== null,
      ).length,
      refused.length,
    ),
    totalTurns: reports.reduce((sum, report) => sum + report.turns, 0),
    totalRetries: reports.reduce((sum, report) => sum + report.retries, 0),
    inputTokens: reports.reduce((sum, report) => sum + report.usage.inputTokens, 0),
    outputTokens: reports.reduce((sum, report) => sum + report.usage.outputTokens, 0),
  };
}

function widenedDesk(): SceneSpec {
  const spec = makeDeskGenesis();
  const top = boxNode(spec, DESK_TOP_ID);
  if (top !== undefined) top.params.width = 1.92;
  return spec;
}

function widenedDeskWithLamp(): SceneSpec {
  const spec = widenedDesk();
  const desk = findNode(spec, "desk");
  if (desk?.kind === "group" && !desk.children.includes(DESK_LAMP_ID)) {
    desk.children.push(DESK_LAMP_ID);
  }
  spec.nodes.push({
    kind: "procedural",
    id: DESK_LAMP_ID,
    name: "Desk lamp",
    transform: { position: [0.65, 0.985, -0.3], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    op: "cylinder",
    params: {
      radiusTop: 0.05,
      radiusBottom: 0.07,
      height: 0.35,
      radialSegments: 24,
      heightSegments: 1,
      capped: true,
    },
    seed: 7,
    materialId: DESK_OAK_ID,
  });
  return spec;
}

function lampInput(): Record<string, unknown> {
  return {
    op: "add_node",
    parentId: "desk",
    node: {
      kind: "procedural",
      id: DESK_LAMP_ID,
      name: "Desk lamp",
      transform: { position: [0.65, 0.985, -0.3], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      op: "cylinder",
      params: {
        radiusTop: 0.05,
        radiusBottom: 0.07,
        height: 0.35,
        radialSegments: 24,
        heightSegments: 1,
        capped: true,
      },
      seed: 7,
      materialId: DESK_OAK_ID,
    },
  };
}

const GET_SCENE: ModelTraffic = { name: "get_scene", input: {} };

function propose(input: Record<string, unknown>): ModelTraffic {
  return { name: "propose_scene_patch", input };
}

export const EVAL_CASES: EvalCase[] = [
  {
    id: "genesis-desk",
    title: "Genesis: modern desk with top and four legs",
    prompt: "Create a simple modern desk with a rectangular top and four legs.",
    kind: "genesis",
    baseSpec: () => null,
    traffic: () => [
      GET_SCENE,
      propose({ spec: makeDeskGenesis(), rationale: "Oak desk, rectangular top on four legs." }),
    ],
    check: (_before, after) => {
      if (after === null) return [{ name: "scene-created", pass: false, detail: "no head" }];
      const top = boxNode(after, DESK_TOP_ID);
      const legs = DESK_LEG_IDS.map((id) => boxNode(after, id));
      const topBottom =
        top === undefined ? Number.NaN : top.transform.position[1] - top.params.height / 2;
      return [
        {
          name: "rectangular-top",
          pass:
            top !== undefined &&
            top.params.width !== top.params.depth &&
            top.params.width > top.params.depth,
          detail:
            top === undefined ? "no top" : `width ${top.params.width}, depth ${top.params.depth}`,
        },
        {
          name: "four-legs",
          pass: legs.every((leg) => leg !== undefined),
          detail: `${legs.filter((leg) => leg !== undefined).length}/4 legs present`,
        },
        {
          name: "legs-meet-top",
          pass:
            top !== undefined &&
            legs.every(
              (leg) =>
                leg !== undefined &&
                Math.abs(leg.transform.position[1] + leg.params.height / 2 - topBottom) <= 0.002,
            ),
          detail: `leg tops vs top bottom ${Number.isNaN(topBottom) ? "unknown" : topBottom.toFixed(3)}`,
        },
      ];
    },
  },
  {
    id: "widen-20",
    title: "Parameter edit: desk 20 percent wider",
    prompt: "Make the desk 20 percent wider.",
    kind: "edit",
    baseSpec: makeDeskGenesis,
    traffic: (baseHash) => [
      GET_SCENE,
      propose({
        baseHash,
        ops: [{ op: "set_param", nodeId: DESK_TOP_ID, key: "width", value: 1.92 }],
        rationale: "Widen the desktop from 1.6m to 1.92m.",
      }),
    ],
    check: (before, after) => {
      const beforeTop = before === null ? undefined : boxNode(before, DESK_TOP_ID);
      const afterTop = after === null ? undefined : boxNode(after, DESK_TOP_ID);
      if (beforeTop === undefined || afterTop === undefined) {
        return [{ name: "width-ratio", pass: false, detail: "top missing before or after" }];
      }
      return [
        ratioCheck("width-ratio", afterTop.params.width / beforeTop.params.width, 1.2, 0.005),
        {
          name: "other-top-params-stable",
          pass:
            afterTop.params.height === beforeTop.params.height &&
            afterTop.params.depth === beforeTop.params.depth,
          detail: `height ${afterTop.params.height}, depth ${afterTop.params.depth}`,
        },
      ];
    },
  },
  {
    id: "add-lamp",
    title: "Component addition: desk lamp at the back-right corner",
    prompt: "Add a small desk lamp attached to the back-right corner.",
    kind: "edit",
    baseSpec: widenedDesk,
    traffic: (baseHash) => [
      GET_SCENE,
      propose({
        baseHash,
        ops: [lampInput()],
        rationale: "Cylinder lamp on the back-right corner.",
      }),
    ],
    check: (before, after) => {
      if (before === null || after === null)
        return [{ name: "lamp-placed", pass: false, detail: "missing spec" }];
      const lamp = findNode(after, DESK_LAMP_ID);
      const surface = deskTopSurfaceY(before) ?? Number.NaN;
      const top = boxNode(before, DESK_TOP_ID);
      const halfWidth = top === undefined ? Number.NaN : top.params.width / 2;
      if (lamp?.kind !== "procedural" || lamp.op !== "cylinder") {
        return [{ name: "lamp-placed", pass: false, detail: "no cylinder lamp node" }];
      }
      const [x, y, z] = lamp.transform.position;
      const lampBottom = y - lamp.params.height / 2;
      return [
        {
          name: "lamp-within-footprint",
          pass: Math.abs(x) <= halfWidth,
          detail: `x ${x.toFixed(3)} vs half-width ${halfWidth.toFixed(3)}`,
        },
        {
          name: "lamp-at-back",
          pass: z < 0,
          detail: `z ${z.toFixed(3)} (back is negative z)`,
        },
        {
          name: "lamp-sits-on-top",
          pass: Math.abs(lampBottom - surface) <= 0.01,
          detail: `lamp bottom ${lampBottom.toFixed(3)} vs surface ${surface.toFixed(3)}`,
        },
      ];
    },
  },
  {
    id: "remove-lamp",
    title: "Component removal: take the lamp away",
    prompt: "Remove the lamp.",
    kind: "edit",
    baseSpec: widenedDeskWithLamp,
    traffic: (baseHash) => [
      GET_SCENE,
      propose({
        baseHash,
        ops: [{ op: "remove_node", nodeId: DESK_LAMP_ID }],
        rationale: "Remove the desk lamp.",
      }),
    ],
    check: (before, after) => {
      if (before === null || after === null)
        return [{ name: "lamp-gone", pass: false, detail: "missing spec" }];
      const beforeTop = boxNode(before, DESK_TOP_ID);
      const afterTop = boxNode(after, DESK_TOP_ID);
      return [
        {
          name: "lamp-gone",
          pass: findNode(after, DESK_LAMP_ID) === undefined,
          detail: findNode(after, DESK_LAMP_ID) === undefined ? "absent" : "still present",
        },
        {
          name: "rest-untouched",
          pass:
            beforeTop !== undefined &&
            afterTop !== undefined &&
            afterTop.params.width === beforeTop.params.width &&
            afterTop.params.height === beforeTop.params.height &&
            afterTop.params.depth === beforeTop.params.depth,
          detail: `top still ${afterTop?.params.width}×${afterTop?.params.height}×${afterTop?.params.depth}`,
        },
      ];
    },
  },
  {
    id: "walnut-lower-10",
    title: "Multi-property edit: darker walnut, 10 percent lower",
    prompt: "Make the desk darker walnut and reduce its height by 10 percent.",
    kind: "edit",
    baseSpec: widenedDesk,
    traffic: (baseHash) => [
      GET_SCENE,
      propose({
        baseHash,
        ops: [
          { op: "set_material", nodeId: DESK_TOP_ID, materialId: DESK_WALNUT_ID },
          ...DESK_LEG_IDS.map((id) => ({
            op: "set_material",
            nodeId: id,
            materialId: DESK_WALNUT_ID,
          })),
          { op: "set_param", nodeId: DESK_TOP_ID, key: "height", value: 0.054 },
          ...DESK_LEG_IDS.map((id) => ({
            op: "set_param",
            nodeId: id,
            key: "height",
            value: 0.675,
          })),
          {
            op: "set_transform",
            nodeId: DESK_TOP_ID,
            transform: { position: [0, 0.702, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
          },
          ...DESK_LEG_IDS.map((id) => ({
            op: "set_transform",
            nodeId: id,
            transform: {
              position: [
                id === "leg-fl" || id === "leg-fr" ? -0.73 : 0.73,
                0.3375,
                id === "leg-fl" || id === "leg-bl" ? -0.33 : 0.33,
              ],
              rotationEuler: [0, 0, 0],
              scale: [1, 1, 1],
            },
          })),
        ],
        rationale: "Swap oak for walnut and lower every height by ten percent.",
      }),
    ],
    check: (before, after) => {
      if (before === null || after === null)
        return [{ name: "walnut", pass: false, detail: "missing spec" }];
      const beforeColor = materialColor(before, DESK_OAK_ID) ?? "#ffffff";
      const walnutColor = materialColor(after, DESK_WALNUT_ID) ?? "#000000";
      const top = boxNode(after, DESK_TOP_ID);
      const beforeTop = boxNode(before, DESK_TOP_ID);
      const legRatios = DESK_LEG_IDS.map((id) => {
        const a = boxNode(after, id);
        const b = before === null ? undefined : boxNode(before, id);
        return a !== undefined && b !== undefined ? a.params.height / b.params.height : Number.NaN;
      });
      return [
        {
          name: "walnut",
          pass: top?.materialId === DESK_WALNUT_ID,
          detail: `top material ${top?.materialId}`,
        },
        {
          name: "darker",
          pass: luminance(walnutColor) < luminance(beforeColor),
          detail: `walnut ${luminance(walnutColor).toFixed(3)} vs oak ${luminance(beforeColor).toFixed(3)}`,
        },
        {
          name: "height-ratio",
          pass:
            beforeTop !== undefined &&
            top !== undefined &&
            Math.abs(top.params.height / beforeTop.params.height - 0.9) <= 0.005 &&
            legRatios.every((ratio) => Math.abs(ratio - 0.9) <= 0.005),
          detail: `top ${top === undefined || beforeTop === undefined ? "?" : (top.params.height / beforeTop.params.height).toFixed(4)}, legs ${legRatios.map((ratio) => ratio.toFixed(3)).join(", ")}`,
        },
      ];
    },
  },
  {
    id: "monitor-centered",
    title: "Spatial relationship: monitor centered on the desk",
    prompt: "Place the monitor centered on the desk.",
    kind: "edit",
    baseSpec: widenedDesk,
    traffic: (baseHash) => [
      GET_SCENE,
      propose({
        baseHash,
        ops: [
          {
            op: "add_node",
            parentId: "desk",
            node: {
              kind: "procedural",
              id: DESK_MONITOR_ID,
              name: "Monitor",
              transform: { position: [0, 0.98, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
              op: "box",
              params: { width: 0.56, height: 0.34, depth: 0.04 },
              seed: 7,
              materialId: "glass",
            },
          },
        ],
        rationale: "Box monitor centered on the desktop.",
      }),
    ],
    check: (before, after) => {
      if (before === null || after === null)
        return [{ name: "monitor-centered", pass: false, detail: "missing spec" }];
      const monitor = boxNode(after, DESK_MONITOR_ID);
      const surface = deskTopSurfaceY(before) ?? Number.NaN;
      if (monitor === undefined)
        return [{ name: "monitor-centered", pass: false, detail: "no monitor node" }];
      const [x, y, z] = monitor.transform.position;
      return [
        {
          name: "monitor-centered",
          pass: Math.abs(x) <= 0.05 && Math.abs(z) <= 0.05,
          detail: `x ${x.toFixed(3)}, z ${z.toFixed(3)}`,
        },
        {
          name: "monitor-on-desk",
          pass: y - monitor.params.height / 2 >= surface - 0.01,
          detail: `bottom ${(y - monitor.params.height / 2).toFixed(3)} vs surface ${surface.toFixed(3)}`,
        },
      ];
    },
  },
  {
    id: "ambiguous-stale",
    title: "Invalid request: vague edit against a stale base",
    prompt: "Make it pop.",
    kind: "refused",
    baseSpec: widenedDesk,
    traffic: () => [
      GET_SCENE,
      propose({
        baseHash: "f".repeat(64),
        ops: [{ op: "set_param", nodeId: DESK_TOP_ID, key: "width", value: 9 }],
        rationale: "Vague request guessed against an old revision.",
      }),
    ],
    check: (before, after) => {
      if (before === null) return [{ name: "head-unmoved", pass: false, detail: "missing base" }];
      return [
        {
          name: "head-unmoved",
          pass: after !== null && after.nodes.length === before.nodes.length,
          detail:
            after === null
              ? "no head"
              : `${after.nodes.length} nodes, base had ${before.nodes.length}`,
        },
      ];
    },
  },
  {
    id: "unsupported-op",
    title: "Unsupported operation: invented geometry vocabulary",
    prompt: "Give the desktop a swirling nebula finish with an extrude effect.",
    kind: "refused",
    baseSpec: widenedDesk,
    traffic: (baseHash) => [
      GET_SCENE,
      propose({
        baseHash,
        ops: [{ op: "extrude", nodeId: DESK_TOP_ID, profile: "nebula" }],
        rationale: "An operation outside the closed vocabulary.",
      }),
    ],
    check: (before, after) => {
      if (before === null) return [{ name: "head-unmoved", pass: false, detail: "missing base" }];
      return [
        {
          name: "head-unmoved",
          pass: after !== null && after.nodes.length === before.nodes.length,
          detail:
            after === null
              ? "no head"
              : `${after.nodes.length} nodes, base had ${before.nodes.length}`,
        },
      ];
    },
  },
];
