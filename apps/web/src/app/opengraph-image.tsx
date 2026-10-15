import { ImageResponse } from "next/og";

export const alt = "Vibe-VR — create and refine 3D scenes with AI";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        background: "#101014",
        color: "#f4f4f7",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        justifyContent: "space-between",
        padding: "64px 76px",
        width: "100%",
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 18 }}>
        <svg width="58" height="58" viewBox="0 0 32 32" fill="none">
          <path d="m16 3 12 6.5v13L16 29 4 22.5v-13L16 3Z" fill="#b6a0ff" />
          <path d="M16 16v13M4 9.5 16 16l12-6.5" stroke="#fff" strokeWidth="1.4" />
        </svg>
        <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.04em" }}>Vibe-VR</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 950 }}>
        <div
          style={{
            color: "#c9baff",
            fontSize: 23,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          AI 3D creation workspace
        </div>
        <div style={{ fontSize: 76, fontWeight: 600, letterSpacing: "-0.055em", lineHeight: 1.05 }}>
          Turn a prompt into a 3D world.
        </div>
        <div style={{ color: "#a7a7b2", fontSize: 27, lineHeight: 1.4 }}>
          Create, inspect and refine editable scenes with natural language.
        </div>
      </div>
      <div style={{ color: "#777783", fontSize: 20 }}>Describe → Build → Edit → Iterate</div>
    </div>,
    size,
  );
}
