import { describe, expect, it } from "vitest";
import { VERSION } from "./version.ts";

describe("@vibe-vr/shared", () => {
  it("exposes a semver version string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
