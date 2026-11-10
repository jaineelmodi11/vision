import { ImageResponse } from "next/og";

// ============================================================================
// THE LINK PREVIEW.
//
// Generated rather than checked in, so it can never drift from the palette in
// globals.css. Anywhere this gets pasted, a resume, a message, a job
// application, renders this card instead of a bare URL.
// ============================================================================

export const alt =
  "Vision. A simulated market tells you which problem you are actually solving, then an investment committee decides whether it is worth funding.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Paper, ink and the darkened brand blue, matched to :root in globals.css.
const GROUND = "#f6f4ef";
const TEXT = "#191b20";
const MUTED = "#5a6068";
const ACCENT = "#1b69ae";
const BORDER = "#dcd6c9";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: GROUND,
          padding: 72,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 22,
              letterSpacing: 6,
              textTransform: "uppercase",
              color: ACCENT,
            }}
          >
            Hack the North
          </div>

          <div
            style={{
              display: "flex",
              marginTop: 28,
              fontSize: 132,
              lineHeight: 1,
              color: TEXT,
            }}
          >
            Vision
          </div>

          <div
            style={{
              display: "flex",
              marginTop: 28,
              maxWidth: 900,
              fontSize: 38,
              lineHeight: 1.35,
              color: MUTED,
            }}
          >
            A simulated market tells you which problem you are actually solving.
            Then an investment committee argues about whether it is worth
            funding.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: 48,
            borderTop: `2px solid ${BORDER}`,
            paddingTop: 28,
          }}
        >
          {[
            ["326", "simulated professionals"],
            ["25", "investment firms"],
            ["11", "agents deliberating"],
            ["5", "rounds of cross-examination"],
          ].map(([figure, label]) => (
            <div key={label} style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", fontSize: 48, color: TEXT }}>
                {figure}
              </div>
              <div style={{ display: "flex", fontSize: 21, color: MUTED }}>
                {label}
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
    size
  );
}
