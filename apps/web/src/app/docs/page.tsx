import type { Metadata } from "next";
import { DocsPage } from "../../docs/docs-page.tsx";

/**
 * The engineering half of the public site.
 *
 * The landing page answers what Vibe-VR is and why anybody would want it; this answers how it works
 * and why it is built this way. The split is deliberate and the README states the rule: the
 * README carries the compressed story, this carries the mechanisms, and specific numbers live
 * only here.
 */
export const metadata: Metadata = {
  title: "Docs — Vibe-VR",
  description:
    "How Vibe-VR works: scene generation, validated edits, project previews, snapshots, and model configuration.",
};

export default function Page() {
  return <DocsPage />;
}
