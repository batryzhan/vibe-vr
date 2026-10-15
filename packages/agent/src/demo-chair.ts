import type { SceneNode, SceneSpec } from "@vibe-vr/scene-spec/schema";

/** Narrow intent matching keeps explicit styles, dimensions and edits with the model. */
export function isDefaultChairRequest(prompt: string): boolean {
  return /^(?:(?:сделай|создай|построй)(?:\s+мне)?\s+(?:пожалуйста\s+)?стул|(?:make|create|build)(?:\s+me)?\s+(?:a\s+)?chair)[.!?\s]*$/i.test(prompt.trim());
}

/** A curated, dimensionally consistent chair for immediate short-prompt demos. */
export function buildDemoChair(): SceneSpec {
  const nodes: SceneNode[] = [];
  const box = (id: string, name: string, position: [number, number, number], size: [number, number, number], materialId = "walnut", bevel = 0.004) => {
    nodes.push({ id, name, kind: "procedural", op: "box", seed: 42,
      transform: { position, rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      params: { width: size[0], height: size[1], depth: size[2], bevel }, materialId });
  };
  box("seat", "Soft-edged walnut seat", [0, 0.46, 0], [0.48, 0.045, 0.46], "walnut", 0.012);
  box("cushion", "Muted olive upholstered pad", [0, 0.496, 0.005], [0.436, 0.027, 0.408], "upholstery", 0.012);
  for (const [side, x] of [["left", -0.19], ["right", 0.19]] as const) {
    for (const [end, z] of [["front", 0.18], ["rear", -0.18]] as const) {
      nodes.push({ id: `leg_${side}_${end}`, name: `${side} ${end} tapered leg`, kind: "procedural", op: "cylinder", seed: 42,
        transform: { position: [x, 0.21875, z], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        params: { radiusTop: 0.027, radiusBottom: 0.018, height: 0.4375, radialSegments: 24, heightSegments: 1, capped: true }, materialId: "walnut" });
    }
    box(`apron_${side}`, `${side} seat apron`, [x, 0.4075, 0], [0.035, 0.06, 0.36]);
    box(`upright_${side}`, `${side} back upright`, [x, 0.6975, -0.18], [0.038, 0.43, 0.038]);
  }
  for (const [end, z] of [["front", 0.18], ["rear", -0.18]] as const) {
    box(`apron_${end}`, `${end} seat apron`, [0, 0.4075, z], [0.38, 0.06, 0.035]);
  }
  box("back_lower_rail", "Lower back rail", [0, 0.565, -0.18], [0.38, 0.032, 0.035]);
  for (const [index, x] of [-0.095, 0, 0.095].entries()) {
    box(`back_slat_${index}`, `Warm oak back slat ${index + 1}`, [x, 0.724, -0.18], [0.045, 0.286, 0.023], "oak", 0.006);
  }
  box("top_rail", "Rounded crown rail", [0, 0.89, -0.18], [0.44, 0.048, 0.045], "walnut", 0.012);
  const identity = { position: [0, 0, 0] as [number, number, number], rotationEuler: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
  return {
    version: 1, id: crypto.randomUUID(), seed: 42, units: "m", axes: "y-up", root: "chair",
    nodes: [{ id: "chair", name: "Atelier walnut dining chair", kind: "group", transform: identity, children: nodes.map((node) => node.id) }, ...nodes],
    materials: [
      { id: "walnut", name: "Satin walnut", color: "#68432D", metalness: 0, roughness: 0.42 },
      { id: "oak", name: "Natural warm oak", color: "#BA9264", metalness: 0, roughness: 0.48 },
      { id: "upholstery", name: "Muted olive fabric", color: "#777C62", metalness: 0, roughness: 0.92 },
    ],
  };
}
