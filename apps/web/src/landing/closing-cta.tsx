"use client";

/**
 * The last thing on the page: start with a sentence, not a toolchain.
 *
 * Somebody who has read this far has been told what the product does; the
 * closing restates the one action that replaces the traditional workflow —
 * mastering a DCC tool first — with describing what they want. Same two links
 * the hero offers, so there is exactly one decision to make.
 */

import { Emphasised } from "./emphasis.tsx";
import { revealProps, useReveal } from "./use-reveal.ts";
import { WayIn } from "./way-in.tsx";

export function ClosingCta() {
  const { ref, state } = useReveal<HTMLDivElement>();

  return (
    <section
      aria-labelledby="closing"
      className="vibe-vr-grid border-[var(--s-border-1)] border-t px-6 py-28 sm:py-36"
    >
      <div ref={ref} {...revealProps(state)} className="flex flex-col items-center text-center">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--s-text-subtle)]">
          No installs · No engine licenses · No blank-canvas dread
        </p>

        <h2
          id="closing"
          className="mt-5 max-w-2xl text-balance font-display font-extralight text-[2.4rem] text-[var(--s-text-body)] leading-[1.05] tracking-[-0.035em] sm:text-[3.4rem]"
        >
          <Emphasised text="Start with a description." emphasis="description." />
        </h2>

        <p className="mt-5 max-w-md text-balance text-[15px] text-[var(--s-text-muted)] leading-relaxed">
          Skip the traditional 3D workflow. Describe the scene, refine it in conversation, and keep
          every revision.
        </p>

        <div className="mt-9">
          <WayIn />
        </div>
      </div>
    </section>
  );
}
