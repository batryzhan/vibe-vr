import { describe, expect, it } from "vitest";
import { ReferenceImageSchema } from "./reference-image.ts";

describe("reference image admission", () => {
  it("accepts inline supported images and rejects remote URLs, SVG and excessive payloads", () => {
    expect(ReferenceImageSchema.safeParse("data:image/png;base64,aGVsbG8=").success).toBe(true);
    for (const image of [
      "https://example.com/image.png",
      "data:image/svg+xml;base64,AAAA",
      `data:image/png;base64,${"A".repeat(2_800_000)}`,
    ]) {
      expect(ReferenceImageSchema.safeParse(image).success).toBe(false);
    }
  });
});
