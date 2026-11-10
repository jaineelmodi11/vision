"use client";

import { useEffect, useRef, useState } from "react";
import { AgentFace, moodOf } from "@/components/AgentFace";
import { voteShares } from "@/lib/verdict";

// ============================================================================
// THE DELIBERATION, DRAWN.
//
// The protocol's messages are typed and addressed, so the meeting is a graph:
// who challenged whom, who answered, who conceded. Drawing it is the fastest
// way to show that the agents read each other rather than voting in parallel —
// and both councils draw through this one component, because they run through
// one engine.
// ============================================================================

type Seat = { id: string; role: string; weight: number };
type Stance = { stance: number; confidence?: number };
type Message = { id: string; from: string; to: string; kind: string; text: string };

const SHORT: Record<string, string> = {
  gp: "Lead",
  principal: "Principal",
  skeptic: "Skeptic",
  "devils-advocate": "Devil's adv.",
  market: "Market",
  founder: "Founder",
  customer: "Customer",
  regulatory: "Reg & ops",
  capital: "Capital",
  contrarian: "Contrarian",
};

const EDGE: Record<string, string> = {
  challenge: "var(--accent)",
  rebuttal: "var(--muted)",
  concession: "var(--positive)",
};

export function DeliberationGraph({
  seats,
  stances,
  messages,
  active,
  conceded,
  voiced,
  height,
}: {
  seats: Seat[];
  stances: Record<string, Stance | undefined>;
  messages: Message[];
  active?: Set<string>;
  conceded?: Set<string>;
  /** The message being read aloud right now. Null between lines, undefined
   *  when the room is not being read aloud. The voice runs behind the
   *  transcript, so the face that moves and the caption under the table
   *  follow what you can hear, not the newest line to arrive. */
  voiced?: string | null;
  /** Fixed height; by default it grows with the width it is given. */
  height?: number;
}) {
  // Drawn at the width it actually has, so a wider panel spreads the table
  // out instead of blowing the same 300px drawing up. Text stays its size.
  const box = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(300);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setMeasured(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const voting = seats.filter((s) => s.weight > 0);
  // Normalised, the way the score counts them. See voteShares.
  const shares = voteShares(Object.fromEntries(seats.map((s) => [s.id, s.weight])));
  const W = Math.max(260, measured);
  const H = height ?? Math.round(Math.min(330, Math.max(210, W * 0.6)));
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - 36;
  // Faces grow with the table, up to half again their size at the old width.
  // Weight still sets the size, from a floor at which a 10% seat is a face
  // you can read rather than a dot.
  const grow = Math.min(1.5, Math.max(1, R / 69));
  const radius = (s: Seat) => (11 + s.weight * 22) * grow;
  const radiusOf = new Map(voting.map((s) => [s.id, radius(s)]));

  const pos = new Map(
    voting.map((s, i) => {
      const a = -Math.PI / 2 + (i / voting.length) * Math.PI * 2;
      return [s.id, { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, a }];
    })
  );

  // Labels above a face need room above the drawing: the lead partner sits at
  // the top with the biggest face, and its name and stance were drawn off the
  // edge. Grow the canvas upwards by whatever the highest label needs.
  const pad = Math.max(
    0,
    ...voting.map((s) => {
      const p = pos.get(s.id)!;
      return p.y < cy - 1 ? radius(s) + 22 - p.y : 0;
    })
  );

  const directed = messages.filter((m) => m.to !== "room" && pos.has(m.from) && pos.has(m.to));
  const latest =
    voiced === undefined
      ? messages[messages.length - 1]
      : messages.find((m) => m.id === voiced);
  const latestEdge =
    voiced === undefined
      ? [...directed].reverse()[0]
      : directed.find((m) => m.id === voiced);
  // Between two spoken lines nobody's mouth moves, but the caption keeps the
  // last thing said rather than blanking.
  const caption = latest ?? messages[messages.length - 1];

  return (
    <div ref={box}>
      <svg
        viewBox={`0 ${-pad} ${W} ${H + pad}`}
        className="w-full"
        role="img"
        aria-label="Who challenged whom in this deliberation"
      >
        <defs>
          {Object.entries(EDGE).map(([kind, color]) => (
            <marker
              key={kind}
              id={`tip-${kind}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill={color} />
            </marker>
          ))}
        </defs>

        {/* The table. */}
        <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--border)" strokeDasharray="2 4" />

        {/* The chair: routes the questions, never votes. */}
        <circle cx={cx} cy={cy} r={4} fill="var(--faint)" />
        <text x={cx} y={cy + 16} textAnchor="middle" className="fill-[var(--faint)] font-mono text-[10px] uppercase tracking-[0.14em]">
          chair
        </text>

        {directed.map((m) => {
          const a = pos.get(m.from)!;
          const b = pos.get(m.to)!;
          // Bow each edge toward the middle of the table, and offset by
          // direction so A→B and B→A never draw on top of each other.
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const nx = -(b.y - a.y);
          const ny = b.x - a.x;
          const len = Math.hypot(nx, ny) || 1;
          const bow = 0.18 * len;
          const qx = mx + (cx - mx) * 0.45 + (nx / len) * bow * 0.35;
          const qy = my + (cy - my) * 0.45 + (ny / len) * bow * 0.35;
          const trim = (p: { x: number; y: number }, toward: { x: number; y: number }, by: number) => {
            const dx = toward.x - p.x;
            const dy = toward.y - p.y;
            const d = Math.hypot(dx, dy) || 1;
            return { x: p.x + (dx / d) * by, y: p.y + (dy / d) * by };
          };
          // Trimmed to each face's own size, so the arrowhead lands on the
          // edge of whoever was addressed rather than under a big face or
          // short of a small one.
          const start = trim(a, { x: qx, y: qy }, (radiusOf.get(m.from) ?? 14) + 2);
          const end = trim(b, { x: qx, y: qy }, (radiusOf.get(m.to) ?? 14) + 5);
          const isLatest = m.id === latestEdge?.id;
          const color = EDGE[m.kind] ?? "var(--muted)";

          return (
            <path
              key={m.id}
              d={`M${start.x},${start.y} Q${qx},${qy} ${end.x},${end.y}`}
              fill="none"
              stroke={color}
              strokeWidth={isLatest ? 1.8 : 1.1}
              strokeOpacity={isLatest ? 1 : 0.4}
              markerEnd={`url(#tip-${m.kind in EDGE ? m.kind : "rebuttal"})`}
              className={isLatest ? "flow" : undefined}
            >
              <title>{`${SHORT[m.from] ?? m.from} → ${SHORT[m.to] ?? m.to}: ${m.text}`}</title>
            </path>
          );
        })}

        {voting.map((s) => {
          const p = pos.get(s.id)!;
          const v = stances[s.id];
          const r = radius(s);
          const speaking = latest?.from === s.id;
          const labelBelow = p.y >= cy - 1;

          return (
            <g key={s.id}>
              {/* The adversary, or anyone addressing the whole room, pulses. */}
              {speaking && latest?.to === "room" && (
                <circle cx={p.x} cy={p.y} r={r} fill="none" stroke={EDGE[latest.kind] ?? "var(--muted)"} strokeWidth={1.2}>
                  <animate attributeName="r" from={r} to={r + 16} dur="1.4s" repeatCount="indefinite" />
                  <animate attributeName="stroke-opacity" from="0.9" to="0" dur="1.4s" repeatCount="indefinite" />
                </circle>
              )}
              {active?.has(s.id) && (
                <circle cx={p.x} cy={p.y} r={r + 4} fill="none" stroke="var(--accent)" strokeOpacity={0.6}>
                  <animate attributeName="stroke-opacity" values="0.7;0.1;0.7" dur="1.1s" repeatCount="indefinite" />
                </circle>
              )}
              {/* A face rather than a labelled circle. A circle with a number
                  in it does not look like it is arguing. You have to read the
                  graph to know anything is happening. A face is the one shape
                  people parse without trying, and everything it does here is
                  bound to real state: the mouth moves only while this agent is
                  actually speaking, the brows follow its stance, and it looks
                  toward whoever it just addressed. */}
              <foreignObject
                x={p.x - r}
                y={p.y - r}
                width={r * 2}
                height={r * 2}
                style={{ overflow: "visible" }}
              >
                <AgentFace
                  mood={moodOf(v?.stance)}
                  speaking={speaking}
                  thinking={Boolean(active?.has(s.id)) && !v}
                  conceded={Boolean(conceded?.has(s.id))}
                  gaze={
                    // Look at the agent just addressed, so the graph reads as a
                    // conversation rather than a set of portraits.
                    speaking && latest && latest.to !== "room"
                      ? Math.sign((pos.get(latest.to)?.x ?? p.x) - p.x)
                      : 0
                  }
                  size={r * 2}
                />
              </foreignObject>
              <title>{`${s.role} · ${shares[s.id] ?? 0}% of the vote${v ? ` · stance ${v.stance.toFixed(2)}` : ""}`}</title>
              <text
                x={p.x}
                y={labelBelow ? p.y + r + 12 : p.y - r - 6}
                textAnchor="middle"
                className="fill-[var(--text)] font-mono text-[11px] uppercase tracking-[0.12em]"
              >
                {SHORT[s.id] ?? s.role}
              </text>
              {v && (
                <text
                  x={p.x}
                  y={labelBelow ? p.y + r + 22 : p.y - r - 16}
                  textAnchor="middle"
                  className="font-mono text-[10px]"
                  fill={
                    v.stance > 0.2
                      ? "var(--go)"
                      : v.stance < -0.2
                        ? "var(--stop)"
                        : "var(--caution)"
                  }
                >
                  {v.stance > 0.2 ? "supports" : v.stance < -0.2 ? "rejects" : "unsure"}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="mt-1 min-h-[34px]">
        {caption ? (
          <p key={caption.id} className="narrate text-[13px] leading-snug text-ink/80">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em]" style={{ color: EDGE[caption.kind] ?? "var(--muted)" }}>
              {SHORT[caption.from] ?? caption.from} → {caption.to === "room" ? "the room" : SHORT[caption.to] ?? caption.to} · {caption.kind}
            </span>{" "}
            {caption.text}
          </p>
        ) : (
          <p className="text-[13px] text-faint">Nobody has spoken yet.</p>
        )}
      </div>

      <div className="mt-2 flex gap-3 font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
        <span style={{ color: "var(--accent)" }}>— challenge</span>
        <span>— rebuttal</span>
        <span style={{ color: "var(--positive)" }}>— concession</span>
      </div>
    </div>
  );
}
