# UI Registry — visual consistency baseline

> Established via `/imprint audit`, confirmed by the developer. This file is the
> consistency reference for UI work: read it before writing any component.
> It records what **is** (established), what **should change** (proposed), and
> what **deviates on purpose** (exceptions). It does not itself change any
> component — fixes require explicit approval.

Token source of truth: `apps/web/src/app/globals.css` (`@theme`). The palette is
deliberately narrow — surface, panel, edge, ink, ink-2, muted, accent, danger,
field, hover — plus three shadows and one chip radius. Anything outside it must
be recorded here with a reason.

## Baseline — established conventions

| Property              | Class / value                                                              |
| --------------------- | -------------------------------------------------------------------------- |
| Panel / face bg       | `bg-panel`, borders `border-edge`                                          |
| Controls, chips, inputs, buttons | `rounded-chip` (7px token), wells `bg-field`, hover `bg-hover`   |
| Panel faces           | `rounded-xl`                                                               |
| Pills, avatars        | `rounded-full` (only these)                                                |
| Text primary / secondary / muted | `text-ink` / `text-ink-2` / `text-muted`                        |
| Alarm text            | `text-danger` — the only alarm; no success color by design                 |
| Text accent           | `text-accent-ink` on dark grounds (accent fill fails text contrast)        |
| Focus                 | `focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent` |
| Shadows               | `shadow-card` composer, `shadow-raised` floating menus, `shadow-hairline` inset chips; flat panels otherwise |
| Section headers (viewport pattern, accepted) | `font-medium text-ink text-xs uppercase tracking-wide` |
| Mono captions         | `font-mono text-[11px] text-muted`                                         |

**Pattern notes:**
- Hover on interactive rows/controls is `hover:bg-hover hover:text-ink`; disabled is `disabled:cursor-not-allowed disabled:opacity-40`.
- Selection in lists is `bg-hover font-medium text-ink` with `aria-current`; the same signal drives the inspector.
- Errors surface next to the field that caused them with `role="alert"` + `text-danger text-xs`.

## Proposed changes (not applied — need explicit approval)

### P1. Radius consolidation
19 `rounded-*` variants exist repo-wide. The `rounded-[5px]/[6px]/[8px]/[9px]`
cluster sits ±2px from the 7px chip token with no component-specific reason
on record. Proposal: fold near-7px arbitrary radii into `rounded-chip`; keep
`rounded-xl` (faces), `rounded-2xl`/`rounded-[20px]` (landing-scale surfaces),
`rounded-md`/`rounded-[4px]` (dense inline chips), `rounded-full` (pills/avatars)
where a size-specific reason exists. Record any kept exception here before fixing.

### P2. File-viewer syntax colors → semantic tokens
`apps/web/src/files/file-viewer.tsx:54-63` hardcodes nine colors. Three duplicate
existing tokens and should map directly: `#e8e8ee` → `text-ink`, `#8b8b99` →
`text-muted`, `#e05561` → `text-danger`. The remaining six (`#8fd18b`, `#d4a76a`,
`#a48cff`, `#7fc7ff`, `#5a5a68`, plus base `#e8e8ee` already mapped) have no token
equivalent — do **not** force them onto unrelated tokens. Proposal: introduce a
semantic syntax scheme (e.g. `--color-syntax-{string,number,keyword,type,comment}`)
in `globals.css` following the existing token-comment style, then map the viewer
onto it.

### P3. 3D selection color brand alignment (applied, Stage 2)
`apps/web/src/viewport/viewport-scene.ts` highlights selection with emissive
`0x7c5cff`, derived from the brand accent (`--color-accent: #7c5cff`).
Visibility analysis on record: at intensity 0.45 the accent adds marginally more
luminance than the previous blue against both the near-black viewport
(`0x0b0d12`) and the concrete geometry, and violet separates better from the
pure-blue axis of the axes helper. Intensity (0.45), geometry, materials and
selection behavior unchanged. Closed.

## Reviewed exceptions (deviations with a reason — do not "fix")

### E1. `text-accent` occurrences (each verified, none blindly replaced)
- `apps/web/src/dashboard/nap-stickers.tsx:50,147,212` — decorative sticker SVGs
  colored via `currentColor` at large sizes, not legible text; the contrast
  guidance targets text. Intentional.
- `apps/web/src/workspace/workspace-header.tsx:80` — the "nap"
  wordmark link, `hover:text-accent` on a semibold brand mark. Brand-on-hover is
  the point. Intentional.

### E1b. Near-7px radii intentionally preserved (landing doodle system)
- `apps/web/src/dashboard/variants.tsx:89` (`rounded-[6px]` animated ring) and
  `:198` (`rounded-[9px]` tile) belong to the landing-page variant art system
  (`--s-text-primary` scope), not to interface controls. Not controls, not chips —
  out of the consolidation. All other near-7px occurrences (composer, model
  picker, tool-step path chip, dashboard buttons, file-viewer badge, workbench
  tabs) were controls/chips and now use `rounded-chip`.

### E2. Legitimate hardcoded color
- `apps/web/src/ui/icons.tsx:216-225` — third-party brand colors
  (Google logo). Must stay exact.
- Logo/doodle artwork (`nap-mark.tsx`, `morph-card.tsx`, `variants.tsx`,
  `badge-trail.tsx`) — artwork, not interface chrome.
- Preview Resume button (`preview-pane.tsx:242`): `bg-ink` → `hover:bg-white`
  brightens an already-light button with dark text — effective, contrast
  preserved. The composer's send button it claims to match had no hover at all,
  so the send button gained the same `enabled:hover:bg-white` (its
  `transition-[background-color]` already anticipated it). Both solid `bg-ink`
  buttons now behave identically. Resolved, no exception needed.

### E3. Viewport 3D-world colors
Scene background `0x0b0d12` (≈ surface), grid `0x3a4356/0x232a3a` (≈
line-strong/edge), tower concrete `#9aa0a6` (scene content, not chrome). These
live outside Tailwind by nature; alignment is desirable, exact token match is
not required. See P3 for the one open item (selection blue).

## Components to fix (when approved — systematic list)

- [x] `file-viewer.tsx:54-63` — 3 colors mapped to tokens (`ink`, `muted`,
  `danger`); new `--color-syntax-*` scheme for the other 5 (P2, applied).
- [x] Near-7px `rounded-[*]` on controls/chips — folded into `rounded-chip`;
  doodle-art exceptions recorded in E1b (P1, applied).
- [x] `viewport-scene.ts` selection emissive — accent-derived `0x7c5cff` (P3, applied Stage 2).
- [x] `preview-pane.tsx:242` hover — resolved via send-button alignment (E2).

## Imprint log

- Vibe-VR viewport (`apps/web/src/viewport/`): `rounded-chip` controls, `border-edge`
  panels, `bg-panel/field/hover` surfaces, `text-ink/ink-2/muted/danger` only,
  standard focus pattern, section-header + mono-caption patterns above.
  Introduced zero new radius/color variants. 3D-world colors logged under E3/P3.
