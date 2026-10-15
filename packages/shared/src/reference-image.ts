import { z } from "zod";

/** Inline images only: no server-side fetch of caller-controlled URLs. About 2 MB decoded. */
export const ReferenceImageSchema = z
  .string()
  .max(2_800_000)
  .regex(
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
    "Attach a PNG, JPEG or WebP image (maximum 2 MB).",
  );
