"use client";

import { useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { Wordmark } from "@/components/Logo";
import { SessionDiff } from "@/components/SessionDiff";
import { defaultName, diffSessions, useSessions, type SessionSummary } from "@/lib/sessions";
import { useVenture } from "@/lib/store";
import { hubById } from "@/data/globePoints";
import { Minutes } from "@/components/Minutes";
import { Intake } from "@/components/Intake";
import { Landing } from "@/components/Landing";

// ============================================================================
// SAVED RUNS.
//
// A founder does not run this once. They run it, learn the market has a
// different problem, rewrite, and run it again. And the comparison between
// the two runs is worth more than either one alone. This is where that
// comparison lives.
// ============================================================================

const subscribeNothing = () => () => {};

/** False while hydrating, true after. So a returning founder never sees a
 *  flash of "no runs yet" before their saved runs load. */
function useHydrated() {
  return useSyncExternalStore(subscribeNothing, () => true, () => false);
}

export default function Dashboard() {
  const hydrated = useHydrated();
  const router = useRouter();
  const sessions = useSessions((s) => s.sessions);
  const remove = useSessions((s) => s.remove);
  const clear = useSessions((s) => s.clear);
  const setActive = useSessions((s) => s.setActive);
  const start = useVenture((v) => v.start);
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);

  /** A project is one idea plus everything that happens to it. Creating one
   *  records it immediately, so it is in the list even if the founder never
   *  finishes the run. */
  /** The study screen starts the run; this only describes it. The record is
   *  opened there too, so abandoning the form leaves nothing behind. */
  const create = (solution: string, founderProblem?: string) => {
    start(solution);
    useVenture.getState().setPending({
      name: defaultName(solution),
      founderProblem,
    });
    router.push("/study");
  };

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rewrites = new Set(sessions.map((s) => s.parentId).filter(Boolean));

  const load = (s: SessionSummary) => {
    start(s.solution);
    // A fresh run of this idea starts its own record; nothing afterwards
    // should write into this one.
    setActive(null);
    router.push("/study");
  };

  // Nobody has run anything in this browser, so explain what this is instead
  // of showing them an empty list. Also what the server renders, because the
  // server cannot know: a returning founder is spared the flash by a rule in
  // globals.css keyed off the script in the root layout.
  if (!hydrated || (sessions.length === 0 && !creating)) {
    return (
      <Landing
        pending={!hydrated}
        onStart={() => {
          // Whatever a half-finished earlier visit left behind is not what
          // "start" means on this page.
          useVenture.getState().reset();
          router.push("/study");
        }}
      />
    );
  }

  return (
    <main className="min-h-screen bg-ground text-ink">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-edge pb-6">
          <div>
            <Wordmark size={18} />
            <h1 className="mt-4 font-mono text-2xl">Your projects</h1>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
              Start a project with something you built. Each one keeps what you pitched,
              what the market actually had, how it scored and what the committee decided,
              so the next attempt can be compared with the last.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {sessions.length > 0 &&
              (confirming ? (
                <>
                  <button
                    onClick={() => {
                      clear();
                      setConfirming(false);
                    }}
                    className="border border-negative/60 px-3 py-2 font-mono text-[13px] uppercase tracking-[0.14em] text-negative transition hover:bg-negative/10"
                  >
                    Delete all {sessions.length}
                  </button>
                  <button
                    onClick={() => setConfirming(false)}
                    className="px-3 py-2 font-mono text-[13px] uppercase tracking-[0.14em] text-faint transition hover:text-ink"
                  >
                    Keep them
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirming(true)}
                  className="px-3 py-2 font-mono text-[13px] uppercase tracking-[0.14em] text-faint transition hover:text-ink"
                >
                  Clear all
                </button>
              ))}
            <button
              onClick={() => setCreating((v) => !v)}
              className="bg-accent px-4 py-2 font-mono text-[13px] uppercase tracking-[0.14em] text-ground transition hover:brightness-110"
            >
              {creating ? "Cancel" : "New project"}
            </button>
          </div>
        </header>

        <AnimatePresence>
          {creating && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="relative mt-4 min-h-[520px] overflow-hidden border border-edge-bright bg-surface/30">
                <Intake cta="Ask the market" onDone={create} onCancel={() => setCreating(false)} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>


        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {hydrated &&
            sessions.map((s) => {
              const parent = s.parentId ? byId.get(s.parentId) : undefined;
              return (
                <RunCard
                  key={s.id}
                  run={s}
                  parent={parent}
                  parentMissing={Boolean(s.parentId && !parent)}
                  rewritten={rewrites.has(s.id)}
                  onLoad={() => load(s)}
                  onRemove={() => remove(s.id)}
                />
              );
            })}
        </div>
      </div>
    </main>
  );
}

function RunCard({
  run,
  parent,
  parentMissing,
  rewritten,
  onLoad,
  onRemove,
}: {
  run: SessionSummary;
  parent?: SessionSummary;
  parentMissing: boolean;
  rewritten: boolean;
  onLoad: () => void;
  onRemove: () => void;
}) {
  const finished = run.crowdSize > 0;
  const when = new Date(run.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <article className={`flex flex-col p-4 ${parent ? "glow-accent" : "panel"}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="label" style={parent ? { color: "var(--accent)" } : undefined}>
          {parent || parentMissing ? "Rewrite" : "Run"}
          {rewritten && " · rewritten since"}
        </p>
        <p className="num text-[12px] text-faint">{when}</p>
      </div>

      {/* The name first, because that is what a founder scans for. The idea
          underneath it, because that is what they actually pitched. */}
      {run.name && (
        <h3 className="mt-2 text-[17px] leading-tight text-ink">{run.name}</h3>
      )}
      <p className="mt-1.5 line-clamp-2 text-[14px] leading-relaxed text-muted">
        &ldquo;{run.solution}&rdquo;
      </p>

      {!finished ? (
        <p className="mt-3 text-xs text-faint">This run did not finish.</p>
      ) : (
        <>
          <div className="mt-4 space-y-2">
            {run.mismatch ? (
              <>
                <Line k="Pitched" v={run.pitchedProblem} struck />
                <Line k="Market has" v={run.marketProblem} accent />
              </>
            ) : (
              <Line
                k="Aligned"
                v={run.marketProblem ?? "Nobody in the crowd had any of these problems."}
              />
            )}
          </div>

          <p className="num mt-3 text-[12px] text-muted">
            {run.crowdSize} asked · {run.engaged} full attention · sentiment{" "}
            {run.meanSentiment.toFixed(2)}
          </p>

          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-edge pt-3">
            <div>
              <p className="label">Validation</p>
              {run.pvs !== undefined ? (
                <p className="num mt-1 text-sm">
                  {run.pvs}
                  <span className={`ml-1.5 text-[12px] ${run.pvsPassed ? "text-positive" : "text-negative"}`}>
                    {run.pvsPassed ? "cleared" : "below the bar"}
                  </span>
                </p>
              ) : (
                <p className="mt-1 text-[13px] text-faint">No council sat</p>
              )}
              {run.topHub && (
                <p className="num mt-0.5 text-[12px] text-faint">
                  {hubById(run.topHub.hubId)?.label ?? run.topHub.hubId} · fit {run.topHub.fitScore}
                </p>
              )}
            </div>
            <div>
              <p className="label">Committee</p>
              {run.decision ? (
                <>
                  <p
                    className={`num mt-1 text-sm uppercase ${
                      run.decision === "invest"
                        ? "text-positive"
                        : run.decision === "pass"
                          ? "text-negative"
                          : "text-ink"
                    }`}
                  >
                    {run.decision}
                    {run.score !== undefined && (
                      <span className="ml-1.5 text-[12px] text-faint">{run.score.toFixed(2)}</span>
                    )}
                  </p>
                  <p className="mt-0.5 truncate text-[12px] text-faint">{run.firmName}</p>
                </>
              ) : (
                <p className="mt-1 text-[13px] text-faint">Not pitched yet</p>
              )}
            </div>
          </div>

          {run.killShot && (
            <p className="mt-3 border-l-2 border-negative/60 pl-2 text-[13px] leading-relaxed text-ink/75">
              {run.killShot}
            </p>
          )}

          {/* The chair's record of the meeting, kept with the run it decided. */}
          {run.minutes && (
            <details className="mt-3 border-t border-edge pt-3">
              <summary className="label cursor-pointer select-none hover:text-ink">
                Minutes of the meeting{run.minutes.pitch ? " · after the pitch" : ""}
              </summary>
              <div className="mt-3">
                <Minutes minutes={run.minutes} />
              </div>
            </details>
          )}

          {parent && (
            <div className="mt-4 border-t border-edge pt-3">
              <p className="label mb-2">Against the run it came from</p>
              <SessionDiff deltas={diffSessions(parent, run)} />
            </div>
          )}
          {parentMissing && (
            <p className="mt-4 border-t border-edge pt-3 text-[12px] text-faint">
              The run this came from has been removed.
            </p>
          )}
        </>
      )}

      <div className="mt-auto flex items-center gap-3 pt-4">
        <button
          onClick={onLoad}
          className="border border-edge-bright px-3 py-1.5 font-mono text-[12px] uppercase tracking-[0.14em] text-ink/85 transition hover:bg-surface-2"
        >
          Load this idea
        </button>
        <button
          onClick={onRemove}
          className="font-mono text-[12px] uppercase tracking-[0.14em] text-faint transition hover:text-negative"
        >
          Remove
        </button>
      </div>
    </article>
  );
}

function Line({ k, v, struck, accent }: { k: string; v?: string; struck?: boolean; accent?: boolean }) {
  return (
    <div className="grid grid-cols-[76px_1fr] gap-2">
      <span className="label pt-0.5" style={accent ? { color: "var(--accent)" } : undefined}>
        {k}
      </span>
      <span
        className={`text-[13px] leading-relaxed ${
          struck ? "text-muted line-through decoration-negative/60" : "text-ink/85"
        }`}
      >
        {v ?? "—"}
      </span>
    </div>
  );
}
