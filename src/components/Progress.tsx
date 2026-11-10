"use client";

import { motion } from "framer-motion";

// ============================================================================
// PROGRESS AND METERS. One shape for both, used everywhere.
//
// It used to be blocks: thirty-two squares on the boot screen, twenty-five on
// the processing panel, and four different hand-rolled bars elsewhere. Six
// indicators, four designs, none of them related. Blocks also read as a
// terminal from 1994, which is not what the rest of this looks like now.
//
// One track instead, with a rounded fill and a lit head at the leading edge.
// The head is the whole idea: on a bar that is still moving it glows and
// breathes, so you can tell at a glance whether something is working or stuck,
// which a row of squares cannot tell you at all.
//
// Two uses, one look:
//   <Progress>  how far through something we are
//   <Meter>     how big a value is, on a fixed scale
// ============================================================================

const HEIGHTS = { sm: 4, md: 6, lg: 8 } as const;

export type ProgressSize = keyof typeof HEIGHTS;

function Track({
  pct,
  size = "md",
  color = "var(--accent)",
  live = false,
  name,
}: {
  pct: number;
  size?: ProgressSize;
  color?: string;
  live?: boolean;
  /** What a screen reader calls it. A bar with no name is announced as a bare
   *  percentage, of nothing in particular. */
  name: string;
}) {
  const h = HEIGHTS[size];
  const clamped = Math.max(0, Math.min(100, pct));
  // Below a sliver the head sits off the left edge and looks detached.
  const showHead = live && clamped > 1 && clamped < 99.5;

  return (
    <div
      className="relative w-full overflow-visible rounded-full"
      style={{ height: h, background: "color-mix(in srgb, var(--border) 85%, transparent)" }}
      role="progressbar"
      aria-label={name}
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <motion.div
        className="absolute left-0 top-0 rounded-full"
        style={{
          height: h,
          background: `linear-gradient(90deg, color-mix(in srgb, ${color} 45%, transparent), ${color})`,
        }}
        animate={{ width: `${clamped}%` }}
        transition={{ type: "spring", stiffness: 120, damping: 24 }}
      />

      {showHead && (
        <motion.span
          className="absolute rounded-full"
          style={{
            width: h * 1.9,
            height: h * 1.9,
            top: -h * 0.45,
            background: color,
            boxShadow: `0 0 ${h * 2.4}px ${color}`,
          }}
          animate={{
            left: `calc(${clamped}% - ${h * 0.95}px)`,
            opacity: [1, 0.55, 1],
          }}
          transition={{
            left: { type: "spring", stiffness: 120, damping: 24 },
            opacity: { duration: 1.4, repeat: Infinity },
          }}
        />
      )}
    </div>
  );
}

/**
 * How far through something we are. The caption row underneath is part of the
 * component so every progress bar in the app says the same things in the same
 * places.
 */
export function Progress({
  pct,
  left,
  right,
  size = "md",
  color,
  live = true,
  name = "Progress",
}: {
  pct: number;
  /** Accessible name. Say what is progressing when it is not obvious. */
  name?: string;
  /** Caption under the left end. Defaults to the percentage. */
  left?: React.ReactNode;
  /** Caption under the right end. */
  right?: React.ReactNode;
  size?: ProgressSize;
  color?: string;
  /** False once it is finished, so the head stops breathing. */
  live?: boolean;
}) {
  return (
    <div className="w-full">
      <Track pct={pct} size={size} color={color} live={live} name={name} />
      {(left !== undefined || right !== undefined) && (
        <div className="num mt-2 flex justify-between text-[13px] text-faint">
          <span>{left ?? `${Math.round(pct)}%`}</span>
          <span>{right}</span>
        </div>
      )}
    </div>
  );
}

/**
 * How big a value is on a fixed scale. Same track, label above rather than
 * below, and never a moving head, because a meter is not going anywhere.
 */
export function Meter({
  label,
  value,
  max = 100,
  color = "var(--accent)",
  size = "sm",
  note,
}: {
  label: React.ReactNode;
  value: number;
  max?: number;
  color?: string;
  size?: ProgressSize;
  note?: React.ReactNode;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;

  return (
    <div className="w-full">
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[14px]">
        <span className="text-ink/85">{label}</span>
        <span className="num shrink-0" style={{ color }}>
          {value}
          {max !== 100 && <span className="ml-1 text-[12px] text-muted">of {max}</span>}
        </span>
      </div>
      <Track
        pct={pct}
        size={size}
        color={color}
        live={false}
        name={typeof label === "string" ? label : "Meter"}
      />
      {note && <p className="mt-1 text-[12px] leading-snug text-muted">{note}</p>}
    </div>
  );
}
