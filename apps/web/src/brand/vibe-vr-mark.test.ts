import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const component = readFileSync(new URL("./vibe-vr-mark.tsx", import.meta.url), "utf8");
const icon = readFileSync(new URL("../app/icon.svg", import.meta.url), "utf8");

describe("Vibe-VR brand mark", () => {
  it("uses the 3D cube mark in the app icon", () => {
    expect(icon).toContain("<title>Vibe-VR</title>");
    expect(icon).toContain("M16 16v12M5 10l11 6 11-6");
  });

  it("renders a reusable cube mark in the interface", () => {
    expect(component).toContain("export function VibeVrMark");
    expect(component).toContain("vibe-vr-mark");
    expect(component).toContain('viewBox="0 0 32 32"');
  });
});
