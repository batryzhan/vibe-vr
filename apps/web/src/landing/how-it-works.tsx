"use client";

/**
 * How it works, in three short steps.
 *
 * One quiet row under the hero: describe, validate, edit. The pipeline the
 * README documents in full is compressed here to what fits on a doorway —
 * the proposal model, the validation gate, and the editable result. No demo,
 * no animation, nothing to press.
 */

import { SectionHeading } from "./section-heading.tsx";
import { revealProps, useReveal } from "./use-reveal.ts";

const STEPS = [
  {
    title: "Describe",
    body: "Say what you want in words. The agent proposes typed scene operations — never raw geometry.",
  },
  {
    title: "Validate",
    body: "Schema, revision and size checks run first. A rejected proposal changes nothing.",
  },
  {
    title: "Edit",
    body: "Valid scenes build deterministically and stay open to your next sentence.",
  },
] as const;

export function HowItWorks() {
  const { ref, state } = useReveal<HTMLDivElement>();

  return (
    <section
      aria-labelledby="how-it-works"
      className="border-[var(--s-border-1)] border-t px-6 py-20 sm:py-24"
    >
      <div className="mx-auto max-w-5xl">
        <SectionHeading
          id="how-it-works"
          eyebrow="How it works"
          lines={["Describe. Validate. Edit."]}
          emphasis="Validate."
          sub="A conversational construction layer: the model proposes, trusted code checks, the scene only moves on valid revisions."
        />

        <div ref={ref} {...revealProps(state)} className="vibe-vr-reveal mt-12">
          <ol className="grid gap-8 sm:grid-cols-3 sm:gap-6">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-4">
                <span
                  aria-hidden="true"
                  className="font-mono text-[11px] text-[var(--s-text-subtle)] tabular-nums"
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3 className="font-medium text-[var(--s-text-primary)] text-[16px] tracking-[-0.01em]">
                    {step.title}
                  </h3>
                  <p className="mt-1.5 text-[14px] text-[var(--s-text-muted)] leading-relaxed">
                    {step.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
