"use client";

/**
 * The front page's first screen: the positioning, the way in, and the chair.
 *
 * The headline states the thesis — Vibe-VR is a conversational construction
 * layer for editable scenes, not a text-to-3D generator — and the visual
 * beside it is a sample chair standing in for the editable objects the
 * product works on. Two CTAs: start building (primary) and see how it works
 * (secondary, an anchor into the pipeline row one screen down).
 *
 * The small print under the CTAs is a scope note, not marketing: the chair is
 * a sample model, not something Vibe-VR generated, and the signed-in
 * workbench is where live scenes happen.
 *
 * Two quiet background layers keep the white stage alive: hand-drawn doodles
 * in the margins and a trail of 3D-vocabulary badges behind the cursor, both
 * in warm paper tones. Neither touches the content column (`data-no-trail`),
 * and both stand down under reduced motion or on touch screens.
 */

import { BadgeTrail } from "../badge-trail/badge-trail.tsx";
import { Doodles } from "./doodles.tsx";
import { Headline } from "./headline.tsx";
import { HeroViewport } from "./hero-viewport.tsx";

const LINES = ["Describe 3D scenes.", "Build, edit, iterate."] as const;
const SUB =
  "Vibe-VR is a conversational procedural construction layer for editable 3D scenes — validated proposals, deterministic geometry, and revision history, in your browser.";
const EMPHASIS = "edit";

export function Hero() {
  return (
    <section
      aria-labelledby="hero-heading"
      className="vibe-vr-grid relative overflow-hidden px-6 pt-28 pb-20 sm:pt-32 sm:pb-28"
    >
      <Doodles />
      <BadgeTrail />
      {/*
        `data-no-trail`: the badge trail drops nothing that would land on this column. It is one
        attribute on the whole grid rather than one per element, because the gaps between a
        headline, a viewport and a button are not places a badge should sit either.
      */}
      <div
        data-no-trail
        className="relative z-10 mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16"
      >
        <div>
          <p
            id="hero-heading"
            className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--s-text-subtle)]"
          >
            <span
              aria-hidden="true"
              className="inline-block size-1.5 rounded-full bg-[var(--s-accent)]"
            />
            Vibe-VR — AI-native 3D workspace
          </p>
          <div className="mt-5 text-left [&_h1]:text-left [&_p]:mx-0 [&_p]:text-left">
            <Headline lines={LINES} sub={SUB} emphasis={EMPHASIS} />
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href="/sign-up"
              className="rounded-full bg-[var(--s-accent)] px-6 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--s-accent)] focus-visible:outline-offset-2"
            >
              Start describing
            </a>
            <a
              href="#how-it-works"
              className="rounded-full border border-[var(--s-border-1)] px-6 py-2.5 text-sm font-medium text-[var(--s-text-body)] transition-colors hover:border-[var(--s-text-subtle)] hover:text-[var(--s-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--s-text-primary)] focus-visible:outline-offset-2"
            >
              See how it works
            </a>
          </div>

          <p className="mt-6 max-w-md text-[13px] leading-relaxed text-[var(--s-text-subtle)]">
            Describe → Build → Edit → Iterate. Pictured: a sample 3D scene; live scenes happen in
            the workbench after sign-in.
          </p>
        </div>

        <HeroViewport />
      </div>
    </section>
  );
}
