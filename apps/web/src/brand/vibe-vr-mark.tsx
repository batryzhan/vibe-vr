import type { SVGProps } from "react";

/** Compact isometric cube mark used by the Vibe-VR wordmark. */
export function VibeVrMark({ className = "", ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={`vibe-vr-mark ${className}`}
      {...props}
    >
      <path d="m16 3 12 6.5v13L16 29 4 22.5v-13L16 3Z" fill="currentColor" fillOpacity=".12" />
      <path d="m16 3 12 6.5-12 6.7L4 9.5 16 3Z" fill="currentColor" fillOpacity=".9" />
      <path d="M4 9.5v13L16 29V16.2L4 9.5Z" fill="currentColor" fillOpacity=".58" />
      <path d="M28 9.5v13L16 29V16.2l12-6.7Z" fill="currentColor" fillOpacity=".76" />
      <path
        d="m16 3 12 6.5v13L16 29 4 22.5v-13L16 3Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M16 16.2v12.3M4 9.5l12 6.7 12-6.7"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
