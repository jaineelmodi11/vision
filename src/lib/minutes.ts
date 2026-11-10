import type { DeliberationSnapshot } from "@/lib/store";
import type { ICVerdict, Objection } from "@/lib/types";
import { voteShares } from "@/lib/verdict";

// ============================================================================
// THE MINUTES, the chair's document.
//
// A real partner meeting ends with a written record: who was in the room, what
// each partner thought and whether they moved, where they disagreed, what was
// decided and on what conditions, and what happens next. A founder who only
// sees a score has to reconstruct all of that from a transcript.
//
// Pure: written from what the committee already said and decided, so it costs
// no model call, reads the same with or without a key, and can be rewritten
// after the pitch without re-running the room.
// ============================================================================

export type Lean = "for" | "against" | "undecided";

export type Minutes = {
  firm: string;
  takenAt: number;
  keptBy: string;
  /** The problem the room was asked to back. */
  problem?: string;
  present: { role: string; note: string }[];
  views: { role: string; lean: Lean; view: string; moved?: string }[];
  disagreements: string[];
  /** Challenges the chair ruled were never met. The most useful line in a set
   *  of minutes: a hole the room found that nobody filled. */
  unanswered: { from: string; to: string; challenge: string; reason: string }[];
  decision: { decision: ICVerdict["decision"]; score: number; line: string };
  conditions: string[];
  nextSteps: string[];
  /** Filled in once the founder has pitched. */
  pitch?: { turns: number; answered: number; open: string[] };
};

type Msg = DeliberationSnapshot["messages"][number] & { inReplyTo?: string };

/** Only used if the roster has no chair at all. The live title is read off
 *  the roster instead, so a rename here does not also need one there. */
const CHAIR = "Financial Analyst (chair)";

export function leanOf(stance: number): Lean {
  return stance > 0.2 ? "for" : stance < -0.2 ? "against" : "undecided";
}

const LEAN_WORDS: Record<Lean, string> = {
  for: "leaning yes",
  against: "leaning no",
  undecided: "undecided",
};

const DECISION_LINE: Record<ICVerdict["decision"], string> = {
  invest: "The committee backs it.",
  conditional: "The committee would back it, on conditions.",
  pass: "The committee passes, for now.",
};

/**
 * How the worst unanswered objection is introduced, which depends entirely on
 * whether it decided the outcome.
 *
 * This used to read "What sank it:" on every decision. On a pass that is the
 * truth. On an invest it produced "The committee backs it. What sank it: ..."
 * printed in green, a line that argues with itself and with its own colour,
 * and it was the single most confusing thing on the report.
 */
const OPEN_ITEM_LEAD: Record<ICVerdict["decision"], string> = {
  invest: "Still open",
  conditional: "The condition that matters most",
  pass: "What sank it",
};

/** "I did the homework on this one, and I'm not there yet. There's…" → its
 *  first sentence, which is the view; the rest is the argument for it. */
function firstSentence(text: string): string {
  const s = text.trim().match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? text.trim();
  return s.length > 220 ? `${s.slice(0, 217).trimEnd()}…` : s;
}

export function writeMinutes(input: {
  firm: string;
  snapshot: DeliberationSnapshot;
  verdict: ICVerdict;
  problem?: string;
  objections?: Objection[];
  pitchTurns?: number;
  rulings?: { from: string; to: string; challenge: string; answered: boolean; reason: string }[];
  now?: number;
}): Minutes {
  const { snapshot, verdict } = input;
  const roleOf = (id: string) => snapshot.roster.find((r) => r.id === id)?.role ?? id;

  // The chair sits as "Managing Partner" with no vote, so it is known by its
  // seat rather than by its title: matching on the word "chair" listed it
  // twice, once from the roster and once appended here.
  const chaired = (r: { id: string; role: string }) => r.id === "chair" || /chair/i.test(r.role);
  const share = voteShares(Object.fromEntries(snapshot.roster.map((r) => [r.id, r.weight])));
  const seated = snapshot.roster.map((r) => ({
    role: r.role,
    note: chaired(r)
      ? "chairs, keeps these minutes, does not vote"
      : r.weight > 0
        ? `votes · ${share[r.id]}% of the vote`
        : "argues, does not vote",
  }));
  // The chair is in the room even when it is not on the roster the room votes with.
  const present = snapshot.roster.some(chaired)
    ? seated
    : [...seated, { role: CHAIR, note: "chairs, keeps these minutes, does not vote" }];

  const moves = new Map(snapshot.metrics.mindChanges.map((m) => [m.agentId, m]));
  const views = snapshot.verdicts.map((v) => {
    const m = moves.get(v.agentId);
    const from = m ? leanOf(m.from) : undefined;
    const to = leanOf(v.stance);
    return {
      role: roleOf(v.agentId),
      lean: to,
      view: firstSentence(v.position || v.reasoning),
      moved: m
        ? from !== to
          ? `Moved from ${LEAN_WORDS[from!]} to ${LEAN_WORDS[to]}${m.conceded ? ", and conceded the point" : ""}.`
          : m.conceded
            ? `Conceded a point, still ${LEAN_WORDS[to]}.`
            : `Softened, still ${LEAN_WORDS[to]}.`
        : undefined,
    };
  });

  // A challenge the other partner answered by holding their ground is where
  // the room actually disagreed. One they conceded is settled.
  const messages = snapshot.messages as Msg[];
  const disagreements: string[] = [];
  for (const c of messages.filter((m) => m.kind === "challenge" && m.to !== "room")) {
    const reply =
      messages.find((m) => m.inReplyTo === c.id) ??
      messages.find((m) => m.from === c.to && m.to === c.from && m.round > c.round);
    if (reply?.kind === "concession") continue;
    disagreements.push(
      `${roleOf(c.from)} challenged ${roleOf(c.to)}: "${firstSentence(c.text)}"${
        reply ? ` ${roleOf(c.to)} held their position.` : " It was never answered."
      }`
    );
  }
  for (const id of verdict.dissents) {
    disagreements.push(`${roleOf(id)} dissented from where the room landed, and the dissent stands.`);
  }

  const open = (input.objections ?? []).filter((o) => o.status !== "answered");
  const answered = (input.objections ?? []).length - open.length;
  const pitched = (input.pitchTurns ?? 0) > 0;

  const nextSteps = [
    ...(pitched
      ? open.map((o) => `Come back with an answer to: ${o.text.replace(/[.]+$/, "")}.`)
      : ["Pitch the partners in person. Every question left open counts against you at the vote."]),
    verdict.comeBackWhen ? `Come back when ${lowerFirst(verdict.comeBackWhen.replace(/[.]+$/, ""))}.` : "",
  ].filter(Boolean);

  // Read off the live roster rather than hardcoded, the same fix as present
  // above: a title this once matched by name went stale the moment the chair
  // was renamed.
  const chairRole = snapshot.roster.find((r) => r.id === "chair")?.role;
  const keptBy = chairRole ? `${chairRole} (chair)` : CHAIR;

  return {
    firm: input.firm,
    takenAt: input.now ?? Date.now(),
    keptBy,
    problem: input.problem,
    present,
    views,
    disagreements: disagreements.slice(0, 6),
    unanswered: (input.rulings ?? [])
      .filter((r) => !r.answered)
      .map((r) => ({
        from: roleOf(r.from),
        to: roleOf(r.to),
        challenge: r.challenge,
        reason: r.reason,
      })),
    decision: {
      decision: verdict.decision,
      score: verdict.score,
      line: verdict.killShot
        ? `${DECISION_LINE[verdict.decision]} ${OPEN_ITEM_LEAD[verdict.decision]}: ${verdict.killShot.replace(/[.]+$/, "")}.`
        : DECISION_LINE[verdict.decision],
    },
    conditions: verdict.conditions,
    nextSteps,
    pitch: pitched
      ? { turns: input.pitchTurns ?? 0, answered, open: open.map((o) => o.text) }
      : undefined,
  };
}

function lowerFirst(t: string): string {
  return /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}
