"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/Logo";
import { Progress } from "@/components/Progress";

// Boot sequence. Buys the pre-read call its latency back by making the wait
// feel like the system coming online rather than a spinner.

export const COMMITTEE_STEPS = [
  "Waking the room",
  "Loading firm thesis and anti-portfolio",
  "Seating partners",
  "Distributing the venture file",
  "Drafting private pre-reads",
  "Committee ready",
];

export const MARKET_STEPS = [
  "Loading 326 people across 20 hubs",
  "Reading seven attributes each",
  "Calibrating who can actually buy",
  "Seating the hub council",
  "Ready to listen",
];

export function AgentBoot({
  onComplete,
  steps = COMMITTEE_STEPS,
  tagline = "see the problem · defend the answer",
}: {
  onComplete: () => void;
  steps?: string[];
  tagline?: string;
}) {
  const STEPS = steps;
  const [step, setStep] = useState(0);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);

  // Held in a ref so an inline arrow from the parent cannot restart the
  // sequence on every re-render.
  const finish = useRef(onComplete);
  useEffect(() => {
    finish.current = onComplete;
  });

  useEffect(() => {
    const total = 3600;
    const startedAt = performance.now();

    // Driven off elapsed time rather than accumulated increments: setInterval
    // is not a clock, and it drifts badly whenever the main thread is busy —
    // which it is, while the globe is building its geometry.
    const tick = setInterval(() => {
      const elapsed = performance.now() - startedAt;
      const pct = Math.min(100, (elapsed / total) * 100);
      setProgress(pct);
      setStep(Math.min(STEPS.length - 1, Math.floor((elapsed / total) * STEPS.length)));

      if (pct >= 100) {
        clearInterval(tick);
        setDone(true);
        setTimeout(() => finish.current(), 450);
      }
    }, 50);

    return () => clearInterval(tick);
  }, [STEPS.length]);

  return (
    <AnimatePresence>
      {!done && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45 }}
          style={{ backgroundColor: "var(--ground)" }}
          className="fixed inset-0 z-50 flex items-center justify-center"
        >
          <div className="mx-auto w-full max-w-md px-8">
            <div className="mb-8">
              {/* The mark opens as it loads, so the logo IS the progress. */}
              <Logo size={44} open={progress / 100} className="text-ink" />
              <h1 className="mt-4 font-mono text-2xl text-ink">Vision</h1>
              <p className="label mt-1">{tagline}</p>
            </div>

            <motion.p
              key={step}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-6 font-mono text-sm text-muted"
            >
              {STEPS[step]}
            </motion.p>

            <Progress
              name="Loading Vision"
              pct={progress}
              size="lg"
              live={progress < 100}
              right={`${step + 1} of ${STEPS.length}`}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
