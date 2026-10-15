import type { SceneRequestType } from "../dahl-provider.ts";

/**
 * A small, offline routing evaluation set. It measures deterministic request
 * classification only; it does not claim live model quality or latency.
 */
export const SCENE_ORCHESTRATION_EVAL_CASES: readonly {
  id: string;
  prompt: string;
  expected: SceneRequestType;
  spatial: boolean;
  composition: boolean;
}[] = [
  {
    id: "forest-cabin",
    prompt: "Generate a forest with a wooden cabin.",
    expected: "complex_generation",
    spatial: true,
    composition: true,
  },
  {
    id: "lake-behind-cabin",
    prompt: "Add a lake behind the cabin.",
    expected: "spatial_edit",
    spatial: true,
    composition: false,
  },
  {
    id: "cabin-closer-lake",
    prompt: "Move the cabin closer to the lake.",
    expected: "spatial_edit",
    spatial: true,
    composition: false,
  },
  {
    id: "medieval-village",
    prompt: "Create a medieval village.",
    expected: "complex_generation",
    spatial: true,
    composition: true,
  },
  {
    id: "market-center",
    prompt: "Add a market in the center of the village.",
    expected: "spatial_edit",
    spatial: true,
    composition: false,
  },
  {
    id: "car-inside-garage",
    prompt: "Place a red car inside the garage.",
    expected: "spatial_edit",
    spatial: true,
    composition: true,
  },
  {
    id: "dark-sky",
    prompt: "Make the sky darker.",
    expected: "visual_edit",
    spatial: false,
    composition: true,
  },
  {
    id: "remove-second-tree",
    prompt: "Remove only the second tree.",
    expected: "simple_edit",
    spatial: false,
    composition: false,
  },
  {
    id: "mountains-behind-village",
    prompt: "Generate mountains behind the village.",
    expected: "complex_generation",
    spatial: true,
    composition: true,
  },
  {
    id: "snow-environment",
    prompt: "Turn the entire scene into a snowy environment.",
    expected: "visual_edit",
    spatial: false,
    composition: true,
  },
  {
    id: "trees-along-road",
    prompt: "Add three pine trees along the road.",
    expected: "spatial_edit",
    spatial: true,
    composition: false,
  },
  {
    id: "car-facing-lake",
    prompt: "Rotate the car to face the lake.",
    expected: "spatial_edit",
    spatial: true,
    composition: false,
  },
  {
    id: "chair-oak",
    prompt: "Set the chair material to oak.",
    expected: "visual_edit",
    spatial: false,
    composition: true,
  },
  {
    id: "cube-red",
    prompt: "Make the cube red.",
    expected: "simple_edit",
    spatial: false,
    composition: false,
  },
  {
    id: "chair-left-of-desk",
    prompt: "Add a chair to the left of the desk.",
    expected: "spatial_edit",
    spatial: true,
    composition: false,
  },
  {
    id: "cyberpunk-street",
    prompt: "Create a cyberpunk street at night.",
    expected: "complex_generation",
    spatial: true,
    composition: true,
  },
  {
    id: "oak-chair",
    prompt: "Create an oak chair with four legs.",
    expected: "object_creation",
    spatial: false,
    composition: false,
  },
  {
    id: "cinematic-fog",
    prompt: "Make the whole composition cinematic with warm light and fog.",
    expected: "visual_edit",
    spatial: false,
    composition: true,
  },
  {
    id: "widen-desk",
    prompt: "Widen the desk by 20 percent.",
    expected: "simple_edit",
    spatial: false,
    composition: false,
  },
  {
    id: "mountains-and-lake",
    prompt: "Make the mountains taller and add a lake behind the village.",
    expected: "multi_step",
    spatial: true,
    composition: false,
  },
  {
    id: "table-between-houses",
    prompt: "Put the table between the two houses, facing the lake.",
    expected: "spatial_edit",
    spatial: true,
    composition: false,
  },
  {
    id: "car-near-house",
    prompt: "Add a red sports car near the biggest house.",
    expected: "spatial_edit",
    spatial: true,
    composition: true,
  },
  {
    id: "chair-cushion-placement",
    prompt: "Add a forest-green cushion centered on the chair seat.",
    expected: "spatial_edit",
    spatial: true,
    composition: true,
  },
  {
    id: "japanese-village",
    prompt: "Create a Japanese village surrounded by mountains.",
    expected: "complex_generation",
    spatial: true,
    composition: true,
  },
  {
    id: "village-palette",
    prompt: "Change the village palette to moss green and cedar brown.",
    expected: "visual_edit",
    spatial: false,
    composition: true,
  },
  {
    id: "russian-village",
    prompt: "Создай японскую деревню с озером и горами.",
    expected: "complex_generation",
    spatial: true,
    composition: true,
  },
  {
    id: "russian-table",
    prompt: "Поставь стол между двумя домами.",
    expected: "spatial_edit",
    spatial: true,
    composition: false,
  },
  {
    id: "russian-cube",
    prompt: "Сделай куб красным.",
    expected: "simple_edit",
    spatial: false,
    composition: false,
  },
  {
    id: "russian-multistep",
    prompt: "Сделай горы выше и добавь озеро.",
    expected: "multi_step",
    spatial: true,
    composition: false,
  },
];
