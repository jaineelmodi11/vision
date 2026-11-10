"use client";

import { motion } from "framer-motion";
import { Progress } from "@/components/Progress";

// Top-left. What is happening right now, and how far through it is.

export function ProcessingPanel({
  step,
  done,
  total,
  round,
  unit = "Agent turns",
}: {
  step: string;
  done: number;
  total: number;
  round?: string;
  /** What is being counted. People answering, or agents speaking. */
  unit?: string;
}) {
  const pct = total > 0 ? (done / total) * 100 : 0;
  // Finished is finished: the squares stop, the bar fills and the caption says
  // so. A panel whose lights keep chasing each other over a full bar reading
  // "120 / 120" is telling the founder two different things at once, and the
  // one that moves is the one they believe.
  const running = total <= 0 || done < total;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      className="panel panel-bright min-w-[280px] p-4"
    >
      <div className="mb-3 flex items-center gap-3">
        <div className="flex gap-1">
          {Array.from({ length: 5 }, (_, i) => (
            <motion.div
              key={i}
              className="h-2 w-2 bg-accent"
              animate={running ? { opacity: [0.2, 1, 0.2] } : { opacity: 1 }}
              transition={
                running
                  ? { duration: 1, repeat: Infinity, delay: i * 0.15 }
                  : { duration: 0.3 }
              }
            />
          ))}
        </div>
        <span className="font-mono text-sm text-ink">{step}</span>
      </div>

      {round && <p className="label mb-2">{round}</p>}

      <div className="space-y-2">
        <div className="flex items-center justify-between font-mono text-xs">
          <span className="text-muted">{unit}</span>
          <span className="num text-ink">
            {done} / {total}
          </span>
        </div>

        <Progress
          name={step}
          pct={running ? pct : 100}
          live={running}
          right={running ? `${Math.max(0, total - done)} to go` : "done"}
        />
      </div>
    </motion.div>
  );
}
