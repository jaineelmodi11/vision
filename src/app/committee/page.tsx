"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";

import { AgentBoot } from "@/components/hud/AgentBoot";
import { SmallScreenNotice } from "@/components/SmallScreenNotice";
import { ProcessingPanel } from "@/components/hud/ProcessingPanel";
import { AgentFeed, type FeedItem } from "@/components/hud/AgentFeed";
import { FirmPicker } from "@/components/FirmPicker";
import { Intake } from "@/components/Intake";
import { Door, disarmDoor, doorArmed } from "@/components/Door";
import { PartTwoNav } from "@/components/PartTwoNav";
import { Wordmark } from "@/components/Logo";
import { Narrator } from "@/components/Narrator";
import { hubById } from "@/data/globePoints";
import { Boardroom } from "@/components/Boardroom";
import { Subtitles, type SubtitleLine } from "@/components/RoundTable";
import { TableChat, type ChatTurn } from "@/components/TableChat";
import { CommitteeLean, TableLog, type LogLine } from "@/components/TableLog";
import { leanOf, weightsOf } from "@/lib/lean";
import { FIRMS } from "@/data/firms";
import { useVenture, type DeliberationSnapshot } from "@/lib/store";
import { SpeechQueue, voiceFor } from "@/lib/voice/agentVoices";
import { SEATS, CHAIR, DEVILS_ADVOCATE } from "@/lib/agents/vc/seats";
import { detectTier, speak, unlockAudio, type VoiceTier } from "@/lib/voice/client";
import { mayStartSpeaking, narrationKey, useNarratorVoice } from "@/lib/voice/narrator";
import { recordVerdict } from "@/lib/sessions";
import { streamPost } from "@/lib/sse";
import type { ICVerdict } from "@/lib/types";
import { writeMinutes, type Minutes as MinutesDoc } from "@/lib/minutes";
import { Minutes } from "@/components/Minutes";
import { MarketEvidence, type MarketEvidenceProps } from "@/components/MarketEvidence";
import { assess } from "@/lib/advice";
import { rankFromCrowd } from "@/lib/discovery/rank";
import type { Attention } from "@/lib/discovery/types";

// ============================================================================
// PART 2, THE ROOM.
//
// The committee sits at the firm's own HQ and has read the file Part 1 wrote.
// It deliberates over five rounds before the founder says a word.
// ============================================================================

type Msg = {
  id: string;
  round: number;
  from: string;
  to: string;
  kind: FeedItem["kind"];
  text: string;
};
type Verdict = { agentId: string; stance: number; confidence: number; position: string };
type RosterEntry = { id: string; role: string; weight: number };

/**
 * Who is in the room before anyone has spoken.
 *
 * The roster used to arrive with the first streamed event, so landing here
 * showed an empty table and five chairs. They are already sitting there
 * waiting for you, which is the whole feeling of the screen, and the run
 * replaces this with the server's own list the moment it starts.
 */
const SEATED: RosterEntry[] = [SEATS.gp, SEATS.principal, SEATS.skeptic, DEVILS_ADVOCATE, CHAIR].map(
  (a) => ({ id: a.id, role: a.role, weight: a.defaultWeight })
);

// A seat's title never actually changes mid-session, only whether it is on
// screen. Used from the caption log, which runs inside a callback with no
// reactive dependency on the roster, so it needs a lookup that is not one.
const ROLE_OF_SEAT: Record<string, string> = Object.fromEntries(SEATED.map((s) => [s.id, s.role]));

const ROUND_LABEL: Record<number, string> = {
  1: "Round 1 · each on their own",
  2: "Round 2 · questioning each other",
  3: "Round 3 · answering",
  4: "Round 4 · the Devil's Advocate",
};

// 3 findings + 3 challenges + up to 3 rebuttals + 1 adversary
const EXPECTED_TURNS = 10;

/** Nothing from the stream for this long and the founder is offered a way
 *  on. Real model calls can be slow; this only offers, it never decides. */
const STALL_MS = 30_000;

// What each round is for, in a sentence. The protocol explained while it runs.
const ROUND_MEANING: Record<number, string> = {
  0: "The managing partner breaks the decision into questions and hands each one to the partner whose job it is.",
  1: "Each partner answers their own questions first, without hearing the others, so nobody just agrees with the loudest voice.",
  2: "Now they've heard each other, and they push back on specific claims, by name.",
  3: "The partners who were challenged answer. And some change their minds. Every change is written down.",
  4: "The Devil's Advocate argues against wherever the room has landed.",
};

export default function Committee() {
  // Arriving through the door from Part 1 replaces the boot sequence: the
  // doors are the transition, so the room should already be waiting.
  const [throughDoor] = useState(doorArmed);
  const [door, setDoor] = useState<"none" | "open" | "closed">(() =>
    doorArmed() ? "closed" : "none"
  );
  const [booting, setBooting] = useState(() => !doorArmed());

  const [running, setRunning] = useState(false);
  const [roster, setRoster] = useState<RosterEntry[]>(SEATED);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [stances, setStances] = useState<Record<string, Verdict>>({});
  const [active, setActive] = useState<Set<string>>(new Set());
  const [round, setRound] = useState(0);
  const [step, setStep] = useState("Idle");
  const [decision, setDecision] = useState<ICVerdict | null>(null);

  // Hearing the room argue is what makes the multi-agent claim land without
  // being explained. Off by default: audio that starts on its own is hostile.
  const [audio, setAudio] = useState(false);
  const audioRef = useRef(false);
  const narratorOn = useNarratorVoice((s) => s.on);
  const toggleNarrator = useNarratorVoice((s) => s.toggle);
  const narrated = useRef("");
  const [tier, setTier] = useState<VoiceTier | null>(null);
  const [nowSpeaking, setNowSpeaking] = useState<string | null>(null);
  /** Who the current speaker is addressing, so the room turns to look. */
  const [addressing, setAddressing] = useState<string | null>(null);
  /** The line under the table. */
  // Everything said so far, for the scrolling caption log under the table.
  // Capped so a long meeting does not hold every line it has ever said.
  const [subtitleLog, setSubtitleLog] = useState<SubtitleLine[]>([]);
  const logLine = useCallback((id: string, speaker: string, text: string) => {
    setSubtitleLog((log) => [...log, { id, speaker, text }].slice(-40));
  }, []);
  const [paused, setPaused] = useState(false);
  /** True when the pause was taken on the founder's behalf so they could talk
   *  to one partner, rather than chosen from the pause button. Only the first
   *  kind is lifted again when the conversation closes. */
  const pausedByChat = useRef(false);
  /** One line per conversation the founder has had with a partner. */
  const [chatSummaries, setChatSummaries] = useState<
    { id: string; role: string; text: string }[]
  >([]);
  const [chat, setChat] = useState<Record<string, ChatTurn[]>>({});
  /** The seat whose answer we are waiting on, or null. Per seat so the
   *  thinking line only ever appears on the partner actually asked. */
  const [chatBusy, setChatBusy] = useState<string | null>(null);
  const [chatSpeaking, setChatSpeaking] = useState<string | null>(null);



  // Lines wait their turn. The stream arrives far faster than anyone can read
  // or listen, so without a queue the table would flicker through a meeting in
  // two seconds and the subtitles would be unreadable.
  const pending = useRef<Msg[]>([]);
  const draining = useRef(false);
  const pausedRef = useRef(false);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  /** Race through the rest of the meeting. The ref is what the loop reads
   *  mid-line; the state is only so the button can show it is on. */
  const fastForwardRef = useRef(false);
  const [fastForward, setFastForward] = useState(false);

  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;

    while (pending.current.length > 0) {
      while (pausedRef.current) await new Promise((r) => setTimeout(r, 120));

      const m = pending.current.shift()!;
      setNowSpeaking(m.from);
      setAddressing(m.to === "room" ? null : m.to);
      logLine(m.id, ROLE_OF_SEAT[m.from] ?? m.from, m.text);

      // Long enough to read at a natural pace, with a floor so a short line
      // does not flash past. Fast forward keeps every line on screen, just
      // for a fraction of the time, so the argument still passes in front of
      // you rather than jumping straight to the end.
      const ms = fastForwardRef.current
        ? Math.max(220, Math.min(700, m.text.split(/\s+/).length * 35))
        : Math.max(1800, Math.min(7000, m.text.split(/\s+/).length * 230));
      await new Promise((r) => setTimeout(r, ms));
    }

    setNowSpeaking(null);
    setAddressing(null);
    draining.current = false;
  }, [logLine]);
  const queue = useRef<SpeechQueue | null>(null);
  // Each run owns the room; a stuck one is aborted when the founder runs again.
  const runId = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const lastEventAt = useRef(0);
  const [stalled, setStalled] = useState(false);
  const [minutes, setMinutes] = useState<MinutesDoc | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const ventureFile = useVenture((v) => v.ventureFile);
  const replaceVenture = useVenture((v) => v.replace);
  const resetVenture = useVenture((v) => v.reset);
  const setDeliberation = useVenture((v) => v.setDeliberation);
  // What Part 1 found. Read once here so the room can show the case for the
  // pitch beside the case being made against it, rather than asking a founder
  // to remember a sidebar from a screen they already left.
  const crowd = useVenture((v) => v.crowd);
  const deployed = useVenture((v) => v.deployed);
  const callReport = useVenture((v) => v.callReport);
  const [evidenceFilter, setEvidenceFilter] = useState<Attention | null>(null);

  useEffect(() => {
    void detectTier().then(setTier);
    return () => {
      queue.current?.stop();
      abort.current?.abort();
    };
  }, []);

  // A deliberation that has gone quiet: offer the founder a way on.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      if (performance.now() - lastEventAt.current > STALL_MS) setStalled(true);
    }, 1000);
    return () => clearInterval(id);
  }, [running]);
  const firmId = useVenture((v) => v.firmId);
  const roleOf = useCallback(
    (id: string) => roster.find((r) => r.id === id)?.role ?? id,
    [roster]
  );

  const sidebar = useRef<HTMLDivElement>(null);

  const firm = FIRMS[firmId] ?? FIRMS.bessemer;
  const hq = hubById(firm.hqHubId) ?? hubById("sf")!;

  useEffect(() => {
    if (!throughDoor) return;
    disarmDoor();
    const open = setTimeout(() => setDoor("open"), 900);
    const gone = setTimeout(() => setDoor("none"), 1800);
    return () => {
      clearTimeout(open);
      clearTimeout(gone);
    };
  }, [throughDoor]);

  useEffect(() => {
    sidebar.current?.scrollTo({ top: sidebar.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  // When the room decides, the minutes are the thing to read. Above the
  // transcript they summarise.
  useEffect(() => {
    if (minutes) sidebar.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [minutes]);

  const dismiss = useCallback((id: string) => {
    setFeed((f) => f.filter((i) => i.id !== id));
  }, []);

  const newQueue = useCallback(
    () =>
      new SpeechQueue(
        // Playback only needs synthesis, which browsers without speech
        // recognition still have, the "text" tier is about the microphone.
        (text, voice) => speak(text, voice, tier === "elevenlabs" ? "elevenlabs" : "browser"),
        (agentId) => {
          // The narrator is not in the room; only partners show as speaking.
          setNowSpeaking(agentId === "narrator" ? null : agentId);
        }
      ),
    [tier]
  );

  /** One queue for the partners and the narrator, so they never overlap. */
  const ensureQueue = useCallback(() => {
    queue.current ??= newQueue();
    return queue.current;
  }, [newQueue]);

  /**
   * Ask one partner something, in private. Their answer can move their stance,
   * which moves the room, which is the point of being able to talk to them at
   * all. A conversation that cannot change anything is set dressing.
   *
   * Defined after the queue on purpose: the reply is spoken through the same
   * queue the meeting uses, so a partner answering you can never start on top
   * of the room.
   */
  const askPartner = useCallback(
    async (seatId: string, question: string) => {
      const vf = useVenture.getState().ventureFile;
      if (!vf) return;

      setChat((c) => ({ ...c, [seatId]: [...(c[seatId] ?? []), { speaker: "founder", text: question }] }));
      setChatBusy(seatId);

      try {
        const res = await fetch("/api/vc/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seatId,
            question,
            firmId,
            ventureFile: vf,
            history: chat[seatId] ?? [],
            stance: stances[seatId]?.stance,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "ask failed");

        setChat((c) => ({
          ...c,
          [seatId]: [...(c[seatId] ?? []), { speaker: "agent", text: json.line }],
        }));

        // Only the fields that belong. Spreading the whole reply in here put
        // its line, summary and role inside the stance object.
        if (typeof json.stance === "number") {
          setStances((prev) => ({
            ...prev,
            [seatId]: {
              ...(prev[seatId] ?? {
                agentId: seatId,
                confidence: 0.6,
                position: json.line,
              }),
              stance: json.stance,
            },
          }));
        }
        if (json.summary) {
          setChatSummaries((prev) => [
            ...prev.filter((p) => p.id !== seatId),
            { id: seatId, role: roleOf(seatId), text: json.summary },
          ]);
        }

        // Out loud, in their voice. Part one's calls already answer this way;
        // here the reply arrived as text and nothing ever said it.
        setChatBusy(null);
        if (json.line) {
          setChatSpeaking(seatId);
          await ensureQueue().say(
            `ask-${seatId}-${Date.now()}`,
            seatId,
            json.line,
            voiceFor(seatId)
          );
          setChatSpeaking(null);
        }
      } catch {
        setChat((c) => ({
          ...c,
          [seatId]: [...(c[seatId] ?? []), { speaker: "agent", text: "Sorry, I lost my train of thought there." }],
        }));
      } finally {
        setChatBusy(null);
        setChatSpeaking(null);
      }
    },
    [chat, firmId, stances, roleOf, ensureQueue]
  );

  const run = useCallback(() => {
    const vf = useVenture.getState().ventureFile;
    if (!vf) return;

    const id = ++runId.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    lastEventAt.current = performance.now();
    setStalled(false);
    let finished = false;

    setRunning(true);
    setMessages([]); setFeed([]); setStances({}); setDecision(null); setMinutes(null);
    pending.current = [];
    setSubtitleLog([]);
    setNowSpeaking(null);
    setAddressing(null);
    // The chair opens by putting the report on the table, which is what starts
    // every one of these meetings in life.
    setTimeout(() => {
      setNowSpeaking("chair");
      const opening = "Right. Let's look at the report.";
      logLine("opening", ROLE_OF_SEAT.chair, opening);
      setTimeout(() => setNowSpeaking(null), 2200);
    }, 350);

    queue.current?.clear();
    if (audio) ensureQueue();
    setRound(0); setStep("Taking their seats"); setSelected(null);
    fastForwardRef.current = false;
    setFastForward(false);

    // What the start event establishes is needed again at the end of the same
    // stream. State would still hold the previous run's values by then, so it
    // is carried in locals, reading `roster` here once left the report with
    // an empty panel and every slider missing.
    let firmName = "";
    let seated: RosterEntry[] = [];

    void streamPost("/api/vc/deliberate", { ventureFile: vf, firmId }, (ev) => {
      if (id !== runId.current) return;
      lastEventAt.current = performance.now();
      setStalled(false);
      if (ev.type === "done" || ev.type === "error") finished = true;
      switch (ev.type) {
        case "start": {
          firmName = (ev.firm as { name: string }).name;
          seated = ev.roster as RosterEntry[];
          setRoster(seated);
          setStep("The chair hands out questions");
          break;
        }

        case "task":
          setActive((a) => new Set(a).add((ev.task as { assignedTo: string }).assignedTo));
          break;

        case "message": {
          const m = ev.message as Msg;
          setMessages((prev) => [...prev, m]);
          setRound(m.round);
          // Drives the table: who is talking, who they are talking to, and the
          // line under the table. The queue paces it so the room speaks one at
          // a time rather than all at once.
          pending.current.push(m);
          drain();
          setStep(ROUND_LABEL[m.round] ?? "Deliberating");
          setFeed((f) =>
            [
              {
                id: m.id,
                agent: seated.find((r) => r.id === m.from)?.role ?? m.from,
                message: m.text,
                kind: m.kind,
              },
              ...f,
            ].slice(0, 4)
          );
          // Queued, not spoken immediately. Deliberation streams faster than
          // speech, so without a queue three partners talk over each other.
          // Fast forward outruns speech entirely, so audio sits out rather
          // than trailing behind what the table has already moved past.
          if (audioRef.current && !fastForwardRef.current) queue.current?.push(m.id, m.from, m.text);
          break;
        }

        case "verdict": {
          const v = ev.verdict as Verdict;
          setStances((s) => ({ ...s, [v.agentId]: v }));
          setActive((a) => {
            const next = new Set(a);
            next.delete(v.agentId);
            return next;
          });
          break;
        }

        case "done": {
          const result = ev.result as {
            finalVerdicts: DeliberationSnapshot["verdicts"];
            messages: DeliberationSnapshot["messages"];
            metrics: DeliberationSnapshot["metrics"];
            rulings?: {
              from: string;
              to: string;
              challenge: string;
              answered: boolean;
              reason: string;
            }[];
          };
          const verdict = ev.verdict as ICVerdict;

          const snapshot: DeliberationSnapshot = {
            firm: firmName,
            verdicts: result.finalVerdicts,
            messages: result.messages,
            roster: seated,
            metrics: result.metrics,
          };
          setDeliberation(snapshot);
          setDecision(verdict);
          // The chair writes up the meeting the moment it ends.
          const written = writeMinutes({
            firm: firmName,
            snapshot,
            verdict,
            problem: vf.chosenProblem?.statement,
            rulings: result.rulings,
          });
          setMinutes(written);
          setStep("The committee has decided");
          setActive(new Set());
          setRunning(false);
          // Persist the verdict onto the venture file so the report and the
          // meeting both see it.
          replaceVenture({ ...vf, verdict });
          recordVerdict(vf.solution, {
            firmId,
            firmName,
            decision: verdict.decision,
            score: verdict.score,
            killShot: verdict.killShot,
            minutes: written,
          });
          break;
        }

        case "error":
          setStep("Failed");
          setRunning(false);
          break;
      }
    }, controller.signal)
      .then(() => {
        // Closed without a verdict: the server died mid-meeting. Waiting on
        // it would leave "Deliberating…" on screen forever.
        if (id === runId.current && !finished) setStalled(true);
      })
      .catch(() => {
        if (id !== runId.current) return;
        setStep("Failed");
        setRunning(false);
      });
  }, [replaceVenture, setDeliberation, firmId, audio, ensureQueue, drain, logLine]);


  // Once the room convenes the argument is the thing to watch: the panel
  // widens and the globe steps back to make room for it.
  // The room is seated from the start now, so a full roster no longer means
  // the meeting has begun. Something has to have been said.
  const convened = running || messages.length > 0 || Boolean(decision);

  const problem = ventureFile?.chosenProblem;
  const pvs = ventureFile?.pvs;
  const researchedIn = ventureFile ? Object.values(ventureFile.hubFindings)[0] : undefined;
  const conceded = new Set(messages.filter((m) => m.kind === "concession").map((m) => m.from));
  const roleName = (id: string) => roster.find((r) => r.id === id)?.role ?? id;

  // Everything Part 1 gathered, read back from the store it was persisted to
  // rather than re-run: the crowd already spoke, and asking them again on
  // this screen would answer a question nobody asked twice.
  const crowdVerdict = crowd?.verdict ?? null;
  const evidenceAdvice = crowdVerdict ? assess(crowdVerdict, crowd?.signals ?? null) : null;
  const evidenceProblems = ventureFile?.extractedProblems ?? [];
  const evidenceMarketProblem = evidenceProblems.find((p) => p.id === crowdVerdict?.marketProblemId);
  const evidenceMarketVote = crowdVerdict?.problemVotes.find(
    (v) => v.problemId === crowdVerdict.marketProblemId
  );
  const evidenceHubRanking = crowdVerdict && deployed ? rankFromCrowd(crowdVerdict, deployed) : [];
  const evidenceReactions =
    crowdVerdict?.reactions.map((r) => {
      const p = deployed?.find((x) => x.id === r.personaId);
      return {
        personaId: r.personaId,
        name: p?.name ?? "Someone",
        title: p?.label ?? p?.title ?? "",
        attention: r.attention,
        reason: r.reason,
        problemId: r.problemId,
        wouldPay: r.wouldPay,
      };
    }) ?? [];
  const evidenceProps: MarketEvidenceProps = {
    advice: evidenceAdvice,
    bet: evidenceMarketProblem ?? problem,
    asked: crowdVerdict?.reactions.length ?? 0,
    have: evidenceMarketVote?.votes ?? 0,
    payRate: evidenceMarketVote?.payRate ?? 0,
    severity: evidenceMarketVote?.meanSeverity ?? 0,
    hubRanking: evidenceHubRanking,
    hubName: (id: string) => hubById(id)?.label ?? id,
    counts: crowdVerdict?.attention ?? { full: 0, partial: 0, ignore: 0 },
    total: deployed?.length ?? 0,
    hasCrowd: Boolean(crowdVerdict),
    sentimentSpread: crowdVerdict?.sentimentSpread,
    stanceFilter: evidenceFilter,
    onFilterChange: setEvidenceFilter,
    signals: crowd?.signals,
    callReport,
    reactions: evidenceReactions,
    answered: true,
    // No onSelectReaction: a call panel opening mid-committee-meeting is not
    // a feature this room has, so the list is read-only here.
  };

  const narration = decision
    ? {
        title: "The room has spoken",
        line: "Whoever is still red or yellow can be moved. Go work the room, not the scoreboard.",
      }
    : running && stalled
      ? {
          title: "The room has gone quiet",
          line: "Nothing has come back for a while. The model may be slow, or stuck. Keep waiting, run the committee again, or go straight to the pitch.",
        }
    : running
      ? { title: round ? ROUND_LABEL[round] : "Round 0 · decompose", line: ROUND_MEANING[round] }
      : {
          title: "The room",
          line: `${firm.name}'s partners have read your file. Convene them. They argue with each other before you say a word.`,
        };


  // The narrator, out loud: each new line once, through the partners' queue.
  useEffect(() => {
    if (!narratorOn) {
      queue.current?.drop("narrator");
      narrated.current = "";
      return;
    }
    if (booting || !ventureFile) return;
    const key = narrationKey(narration.title, narration.line);
    if (key === narrated.current) return;
    narrated.current = key;
    if (!mayStartSpeaking()) return;
    ensureQueue().replace(`narr:${key}`, "narrator", narration.line);
  }, [narratorOn, booting, ventureFile, narration.title, narration.line, ensureQueue]);

  return (
    <main className="relative h-screen overflow-hidden bg-ground text-ink">
      <SmallScreenNotice />
      {booting && <AgentBoot onComplete={() => setBooting(false)} />}
      {door !== "none" && (
        <Door state={door} title="The committee" subtitle={`${firm.name} · ${hq.label}`} />
      )}
      <AnimatePresence>
        {!booting && !ventureFile && <Intake onDone={() => undefined} />}
      </AnimatePresence>

      <div className="flex h-full">
        {/* ------------------------------- the room ---------------------------- */}
        <div className="relative flex-1">
          {/* A committee sits at a table, not on a map. The globe belonged to
              part one and meant nothing here. */}
          <Boardroom
            className="h-full w-full"
            seats={roster
              .filter((r) => r.weight > 0 || r.id === "chair")
              .map((r) => ({
                id: r.id,
                role: r.role,
                weight: r.weight,
                stance: stances[r.id]?.stance,
              }))}
            speaking={nowSpeaking}
            addressing={addressing}
            thinking={active}
            conceded={conceded}
            selected={selected}
            onSelect={(id) => {
              // A click is the gesture a browser needs before it will play
              // anything, and this is the only one on the way into a chat.
              unlockAudio();
              if (!id && selected) queue.current?.drop(selected);
              // Taking a partner aside stops the room. The meeting used to
              // carry on underneath the conversation: subtitles advancing and
              // other partners talking over the person you pulled out, which
              // made the chat feel broken rather than private. A pause the
              // founder set themselves is left alone, and only a pause this
              // opened is lifted again on the way out.
              if (id && !selected && !paused) {
                pausedByChat.current = true;
                setPaused(true);
                queue.current?.clear();
              }
              setSelected(id);
            }}
          />

          <div className="absolute left-1/2 top-6 z-40 -translate-x-1/2">
            <PartTwoNav current="/committee" />
          </div>

          {/* header: the room, and the file it read. Below the Part 2 bar */}
          <div className="absolute left-6 top-20 z-40 w-[300px]">
            <AnimatePresence mode="wait">
              {running ? (
                <ProcessingPanel
                  key="proc"
                  step={step}
                  done={messages.length}
                  total={EXPECTED_TURNS}
                  round={round ? ROUND_LABEL[round] : undefined}
                />
              ) : (
                <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <Wordmark size={18} />
                  <p className="label mt-3" style={{ color: "var(--accent)" }}>
                    Part two · the committee
                  </p>
                  <p className="mt-1 text-sm text-ink">{firm.name}</p>
                  <p className="label mt-0.5">
                    {hq.label} · {firm.decisionStyle}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <AgentFeed items={feed} onDismiss={dismiss} top="top-20" />

          {/* The card that used to open here as well, showing the same
              partner's weight and raw stance, has gone. One click opened two
              panels, and the numbers on it contradicted the lean the room
              shows on purpose. Everything it said is in the conversation. */}

          {/* The bottom of the room, stacked rather than layered. What is being
              said sits directly above where the round is named, above the
              controls. Three absolutely positioned cards used to overlap. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-6 z-40 flex flex-col items-center gap-3 px-8">
            <Subtitles lines={subtitleLog} paused={paused} />

            {ventureFile && (
              <div className="pointer-events-auto w-[520px] max-w-full">
                <Narrator
                  title={narration.title}
                  line={narration.line}
                  voice={{
                    on: narratorOn,
                    onToggle: () => {
                      unlockAudio();
                      toggleNarrator();
                    },
                  }}
                />
              </div>
            )}

            <div className="panel pointer-events-auto flex items-center gap-1 whitespace-nowrap p-1.5">
              <FirmPicker disabled={running} />
              {decision && !running ? (
                <>
                  <Link
                    href="/report"
                    className="beam bg-accent px-5 py-2 font-mono text-[13px] uppercase tracking-[0.14em] text-ground transition hover:brightness-110"
                  >
                    Pitch them →
                  </Link>
                  <button
                    onClick={run}
                    className="px-3 py-2 font-mono text-[13px] uppercase tracking-[0.14em] text-faint transition hover:text-ink"
                  >
                    Run again
                  </button>
                </>
              ) : running && stalled ? (
                // Offered, never forced: a slow model looks exactly like a
                // stuck one. Running again aborts the stuck stream.
                <>
                  <button
                    onClick={run}
                    className="px-3 py-2 font-mono text-[13px] uppercase tracking-[0.14em] transition hover:brightness-125"
                    style={{ color: "var(--caution)" }}
                  >
                    Run it again ↻
                  </button>
                  <Link
                    href="/report"
                    className="px-3 py-2 font-mono text-[13px] uppercase tracking-[0.14em] text-muted transition hover:text-ink"
                  >
                    Skip to the verdict →
                  </Link>
                </>
              ) : (
                <button
                  onClick={run}
                  disabled={running || !ventureFile}
                  className={`bg-accent px-5 py-2 font-mono text-[13px] uppercase tracking-[0.14em] text-ground transition hover:brightness-110 disabled:bg-edge disabled:text-faint ${
                    running || !ventureFile ? "" : "beam"
                  }`}
                >
                  {running ? "Deliberating…" : "Convene the committee"}
                </button>
              )}
              {/* Audio is opt-in and the toggle sits next to the run button,
                  because a page that starts talking on its own is hostile. */}
              <button
                onClick={() => {
                  unlockAudio();
                  if (audio) {
                    queue.current?.clear();
                    setNowSpeaking(null);
                  } else {
                    // Turned on mid-meeting: speak from the next line on.
                    ensureQueue();
                  }
                  audioRef.current = !audio;
                  setAudio(!audio);
                }}
                title={
                  audio
                    ? "The room is speaking aloud"
                    : "Hear the partners argue out loud"
                }
                className={`px-3 py-2 font-mono text-[13px] uppercase tracking-[0.14em] transition ${
                  audio ? "text-accent" : "text-faint hover:text-ink"
                }`}
              >
                {audio ? "🔊 hearing them" : "🔈 hear them"}
              </button>

              {/* Pause the room. Useful when someone asks a question mid-demo
                  and you need the table to stop talking over you. */}
              {(nowSpeaking || paused) && (
                <button
                  onClick={() => setPaused((v) => !v)}
                  className={`px-3 py-2 font-mono text-[13px] uppercase tracking-[0.14em] transition ${
                    paused ? "text-accent" : "text-faint hover:text-ink"
                  }`}
                  title={paused ? "Let them carry on" : "Stop the room"}
                >
                  {paused ? "▶ resume" : "❚❚ pause"}
                </button>
              )}

              {/* Race through the rest of the deliberation. Every line still
                  shows, just for a fraction of the reading time, so you can
                  outrun a long meeting without missing what was decided.
                  Tied to nowSpeaking as well as running, the same as pause:
                  the table replays at reading pace after the API call has
                  already finished, and a fast provider can leave the room
                  still visibly mid-argument well after running goes false. */}
              {(running || nowSpeaking) && (
                <button
                  onClick={() => {
                    const next = !fastForwardRef.current;
                    fastForwardRef.current = next;
                    setFastForward(next);
                    // Nothing left half-said once the table is racing ahead.
                    if (next) queue.current?.clear();
                  }}
                  className={`px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] transition ${
                    fastForward ? "text-accent" : "text-faint hover:text-ink"
                  }`}
                  title={fastForward ? "Back to a normal pace" : "Race through the rest of the meeting"}
                >
                  {fastForward ? "⏩ fast forwarding" : "⏩ fast forward"}
                </button>
              )}

              {nowSpeaking && !paused && (
                <span className="label animate-pulse px-1" style={{ color: "var(--accent)" }}>
                  {roleOf(nowSpeaking)} speaking
                </span>
              )}

            </div>
          </div>
        </div>

        {/* ------------------------------ sidebar ------------------------------ */}
        <AnimatePresence>
          {selected && (
            <TableChat
              key={selected}
              seatId={selected}
              role={roleOf(selected)}
              stance={stances[selected]?.stance}
              opening={stances[selected]?.position}
              turns={chat[selected] ?? []}
              // Per seat, not one flag for the room. A single boolean meant
              // asking one partner a question and then clicking another showed
              // the second one thinking about a question nobody had put to them.
              thinking={chatBusy === selected}
              speakingNow={chatSpeaking === selected}
              onAsk={(q) => void askPartner(selected, q)}
              onClose={() => {
                // Cut them off rather than letting a reply carry on talking
                // into an empty room after you have walked away.
                queue.current?.drop(selected);
                setChatSpeaking(null);
                setSelected(null);
                if (pausedByChat.current) {
                  pausedByChat.current = false;
                  setPaused(false);
                }
              }}
            />
          )}
        </AnimatePresence>

        <aside
          // A conversation takes 400px of its own, so the log gives some back.
          // With both at full width the room was squeezed into a portrait
          // slot and the partners at each end fell out of frame.
          className={`flex shrink-0 flex-col border-l border-edge bg-surface/40 transition-[width] duration-500 ease-out ${
            convened && !selected ? "w-[min(560px,40vw)]" : "w-96"
          }`}
        >
          {/* What the room is arguing about. Moved from a floating card over
              the table to the top of this column: it belongs with everything
              else the founder reads about the meeting, not over the room. */}
          {ventureFile && (
            <div className="border-b border-edge p-4">
              <p className="label">The file they read</p>
              {problem ? (
                <p className="mt-1.5 text-[12px] leading-relaxed text-ink/85">{problem.statement}</p>
              ) : (
                <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
                  &ldquo;{ventureFile.solution}&rdquo;, no validated problem. The committee will
                  treat that as a finding.
                </p>
              )}
              <div className="num mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
                {pvs && (
                  <span>
                    PVS {pvs.total}
                    <span className={pvs.passed ? "text-positive" : "text-negative"}>
                      {pvs.passed ? " · cleared" : " · below the bar"}
                    </span>
                  </span>
                )}
                {researchedIn && (
                  <span>
                    {hubById(researchedIn.hubId)?.label ?? researchedIn.hubId} fit {researchedIn.fitScore}
                  </span>
                )}
                {problem &&
                  ventureFile.extractedProblems[0] &&
                  ventureFile.extractedProblems[0].id !== problem.id && (
                    <span>research moved the framing</span>
                  )}
              </div>
              <button
                onClick={() => resetVenture()}
                className="label mt-2 underline-offset-4 hover:text-ink hover:underline"
              >
                Different idea
              </button>
            </div>
          )}

          {/* Where the room stands, and everything it has said. The graph
              that used to live here drew the same five people the table now
              shows, so it was saying it twice. */}
          <CommitteeLean lean={leanOf(Object.values(stances), weightsOf(roster))} />

          <TableLog
            direction={running ? step : decision ? "The committee has decided." : undefined}
            lines={messages.map((m): LogLine => ({
              id: m.id,
              from: roleOf(m.from),
              to: m.to === "room" ? undefined : roleOf(m.to),
              text: m.text,
              kind: m.kind as LogLine["kind"],
            }))}
            summaries={chatSummaries}
          />



          <div ref={sidebar} className="flex-1 overflow-y-auto p-4">
            {minutes && (
              <div className="mb-6 border border-edge bg-surface/60 p-3">
                <Minutes minutes={minutes} hideDecision />
              </div>
            )}
            <p className="label">Transcript</p>
            <div className="mt-3 space-y-2">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className="border-l-2 pl-3"
                  style={{
                    borderColor:
                      m.kind === "challenge"
                        ? "var(--accent)"
                        : m.kind === "concession"
                          ? "var(--positive)"
                          : "var(--border-bright)",
                  }}
                >
                  <p className="label">
                    {roleName(m.from)} {m.to === "room" ? "→ the room" : `→ ${roleName(m.to)}`} · {m.kind}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-ink/85">{m.text}</p>
                </div>
              ))}
              {messages.length === 0 && (
                <p className="font-mono text-xs text-faint">Nothing said yet.</p>
              )}
            </div>

            {/* Part 1's case for the pitch, collapsed by default: this column
                already carries the lean, the log and the transcript, and a
                founder mid-meeting wants the argument happening now, not a
                recap of a screen they already left. It is a click away
                rather than gone, which is the difference from before. */}
            {crowdVerdict && (
              <details className="mt-6 border-t border-edge pt-3">
                <summary className="label cursor-pointer select-none hover:text-ink">
                  The evidence from part one
                </summary>
                <div className="-mx-4 mt-3">
                  <MarketEvidence {...evidenceProps} />
                </div>
              </details>
            )}
          </div>

          {/* No PASS/CONDITIONAL/score shows anywhere on this page, not even
              inside the minutes above (hideDecision). This room is a tool for
              reading where each partner stands, not a gate that hands down a
              ruling; the pass/fail framing lives only past "Pitch them →",
              once the founder chooses to go find out. */}
        </aside>
      </div>
    </main>
  );
}
