"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence } from "framer-motion";
import {
  Globe,
  type GlobeArc,
  type GlobeDot,
  type GlobePlace,
} from "@/components/globe/Globe";
import { Narrator } from "@/components/Narrator";
import { AgentBoot, MARKET_STEPS } from "@/components/hud/AgentBoot";
import { ProcessingPanel } from "@/components/hud/ProcessingPanel";
import { SmallScreenNotice } from "@/components/SmallScreenNotice";
import { Intake } from "@/components/Intake";
import { PersonaCall } from "@/components/PersonaCall";
import { StageRail, deriveStages, type Segment } from "@/components/StageRail";
import { Reveal } from "@/components/Reveal";
import { Door, DOOR_MS, armDoor } from "@/components/Door";
import { useVenture } from "@/lib/store";
import { diffSessions, summariseCrowd, useSessions, type SessionDelta } from "@/lib/sessions";
import { streamPost } from "@/lib/sse";
import { aggregate } from "@/lib/discovery/aggregate";
import { SpeechQueue } from "@/lib/voice/agentVoices";
import { detectTier, speak, unlockAudio, type VoiceTier } from "@/lib/voice/client";
import { mayStartSpeaking, narrationKey, useNarratorVoice } from "@/lib/voice/narrator";
import { hubById } from "@/data/globePoints";
import { FIRMS } from "@/data/firms";
import type { ProblemStatement } from "@/lib/types";
import type { Attention, CrowdReaction, CrowdVerdict, FigureKind } from "@/lib/discovery/types";
import { rankFromCrowd, type HubRank } from "@/lib/discovery/rank";
import type { CrowdSignals } from "@/lib/discovery/signals";
import { assess, diagnoseNoMarket } from "@/lib/advice";
import {
  MarketEvidence,
  type EvidenceReaction,
  type MarketEvidenceProps,
} from "@/components/MarketEvidence";
import { Bet } from "@/components/Bet";
import { OtherProblems } from "@/components/OtherProblems";
import { ProblemPopup } from "@/components/ProblemPopup";

// ============================================================================
// PART 1, DISCOVERY, in segments.
//
//   split -> deploy -> listen -> the result
//
// The result is the end of Part 1. A council of five analysts and a 0-100
// validation score used to sit between it and the committee; both are gone.
// They delayed the only judgement that decides anything, and the committee was
// never told anything by them it could not read off the crowd.
//
// The server answers as fast as it can; the screen does not. Everything the
// stream sends is buffered, then played back one segment at a time at a pace a
// person can follow, and each segment ends by waiting for the founder with a
// button that names what comes next. One thing moves at a time.
// ============================================================================

type DeployedPersona = {
  id: number;
  name: string;
  figure: FigureKind;
  title: string;
  /** What to call them on screen: their job, or for a consumer product their
   *  age and interests, because that is how they were asked. */
  label?: string;
  hubId: string;
  lat: number;
  lon: number;
  city: string;
  why: string[];
};

type Batch = { done: number; total: number; batch: CrowdReaction[] };

/** Re-running the rewrite against the same people and problems as run one. */
type RunOptions = {
  problems?: ProblemStatement[];
  personaIds?: number[];
  /** The founder's own problem, typed at intake. */
  founderProblem?: string;
  parentId?: string;
  walkedInWith?: string | null;
};

type RefineDraft = {
  draft: string;
  target: ProblemStatement;
  parentId: string;
  problems: ProblemStatement[];
  personaIds: number[];
  /** The framing run one pitched, carried to the closing card. */
  walkedInWith: string | null;
};

type NextStep =
  | "run"
  | "splitting"
  | "choose"
  | "choosing"
  | "ask"
  | "listening"
  | "show"
  | "rerun"
  | "committee";

/** Segments that play by themselves; the rest wait for the founder. */
const PLAYING: Segment[] = ["split", "deploy", "listen"];

// Pacing, in ms. Slow enough to read, quick enough not to drag.
const PACE = {
  problem: 700, // between candidate problems appearing
  deploy: 1800, // let the arcs land before offering the next step
  batch: 1300, // between groups of answers
};

/** Nothing new from the stream for this long, while the screen is waiting on
 *  it rather than on the founder, and the founder is offered a way on. Real
 *  model calls can take a while; this only offers, it never decides. */
const STALL_MS = 25_000;
const STALL_LINE =
  "Nothing new has come back for a while. The model may just be slow, or stuck. Keep waiting, or carry on with what has arrived.";

// The boot plays once per page load. Coming back from Part 2 is not a cold start.
let booted = false;

const hubName = (id: string) => hubById(id)?.label ?? id;

// Where the idea is sent out from when the crowd deploys. Hack the North.
const HOME = hubById("waterloo") ?? { lat: 43.46, lon: -80.52 };

export default function Discover() {
  const router = useRouter();
  const [booting, setBooting] = useState(() => !booted);

  const ventureFile = useVenture((v) => v.ventureFile);
  const replaceVenture = useVenture((v) => v.replace);
  const resetVenture = useVenture((v) => v.reset);
  const firmId = useVenture((v) => v.firmId);

  // ---- what is on screen
  const [segment, setSegment] = useState<Segment>("idle");
  const [expecting, setExpecting] = useState(0);
  const [deployReady, setDeployReady] = useState(false);
  const [problems, setProblems] = useState<ProblemStatement[]>([]);
  const [personas, setPersonas] = useState<DeployedPersona[]>([]);
  /** What came out of each call, newest first. */
  const [callReport, setCallReport] = useState<
    { personaId: number; name: string; role: string; summary: string; takeaway: string; at: number }[]
  >([]);
  /** Bought by people for themselves, so the crowd was asked as consumers. */
  const [consumer, setConsumer] = useState(false);
  const [reactions, setReactions] = useState<Map<number, CrowdReaction>>(new Map());
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [verdict, setVerdict] = useState<CrowdVerdict | null>(null);
  const [signals, setSignals] = useState<CrowdSignals | null>(null);
  const [showReveal, setShowReveal] = useState(false);
  /** Step two opens as a pop-up: the reading, then the problems. Closing it
   *  puts the other framings in the corner of the globe. */
  const [problemPopup, setProblemPopup] = useState(true);
  /** What the founder typed in the optional problem box at intake, kept so the
   *  pop-up can show it back to them. Null when they left it blank, which is
   *  most runs. */
  const [statedProblem, setStatedProblem] = useState<string | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [onlyEngaged, setOnlyEngaged] = useState(false);
  /** Click a light to see only those people. Null shows everyone. */
  const [stanceFilter, setStanceFilter] = useState<Attention | null>(null);
  const asideRef = useRef<HTMLElement>(null);

  // ---- the refine loop
  const [refine, setRefine] = useState<RefineDraft | null>(null);
  const [refining, setRefining] = useState(false);
  const [delta, setDelta] = useState<SessionDelta[] | null>(null);
  const [walkedInWith, setWalkedInWith] = useState<string | null>(null);
  const isRerun = walkedInWith !== null;

  // ---- the way out of Part 1
  const [door, setDoor] = useState<"none" | "open" | "closed">("none");

  /** Where the market's problem lands hardest, from the crowd alone. Read
   *  only: it tells the founder where this sells, and travels to the
   *  committee's pre-read. Nothing is convened on it any more. */
  const [hubRanking, setHubRanking] = useState<HubRank[]>([]);

  // ---- come back to a finished run and find it still here -----------------
  //
  // Going to the committee and pressing back used to show "Nobody asked yet"
  // over an empty globe, while the dashboard listed the same run as complete.
  // The run was in the store the whole time; this screen's copy of it was not.
  //
  // Restores once, only when this screen has nothing and the store has a
  // finished run. So it can never stamp on a run in progress.
  // Which project this screen is working on. The active record if there is
  // one, otherwise the newest run of the same idea, so a reload or a jump back
  // from the committee still knows what it is called.
  const projects = useSessions((s) => s.sessions);
  const activeId = useSessions((s) => s.activeId);
  const activeProject =
    projects.find((p) => p.id === activeId) ??
    projects.find((p) => p.solution === ventureFile?.solution);



  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;

    const { ventureFile: vf, crowd, deployed } = useVenture.getState();
    if (!vf || !crowd?.verdict || !deployed?.length) return;
    if (personas.length > 0 || segment !== "idle") return;

    restored.current = true;
    const people = deployed as unknown as DeployedPersona[];

    // Deferred out of the effect body on purpose. Restoring seven pieces of
    // state synchronously inside an effect cascades a second render before the
    // first has painted, and touching the playback refs from here makes the
    // compiler treat them as frozen everywhere else in the file.
    queueMicrotask(() => {
      setPersonas(people);
      setProblems(vf.extractedProblems ?? []);
      setReactions(new Map(crowd.verdict.reactions.map((r) => [r.personaId, r])));
      setVerdict(crowd.verdict);
      setSignals(crowd.signals);
      setHubRanking(rankFromCrowd(crowd.verdict, people));

      // Land on the last beat the run reached rather than replaying it, and do
      // not narrate what the founder already heard.
      setSegment("heard");
    });
    // Deliberately does not touch the playback refs. Landing on a finished
    // beat leaves auto-advance nothing to do, and letting the narrator read
    // that beat once is right. It says where you are.
  }, [segment, personas.length]);

  const [tier, setTier] = useState<VoiceTier | null>(null);
  /** One queue for every voice on this screen, so two of them never talk at
   *  once. Only the narrator speaks here now. */
  const speech = useRef<SpeechQueue | null>(null);
  const narratorOn = useNarratorVoice((s) => s.on);
  const toggleNarrator = useNarratorVoice((s) => s.toggle);
  const narrated = useRef("");

  // ---- what has arrived but not been shown yet. Refs, not state: the stream
  // writes here as fast as it likes, and nothing re-renders until playback
  // decides it is time.
  const bufProblems = useRef<ProblemStatement[]>([]);
  const bufPersonas = useRef<DeployedPersona[]>([]);
  const bufBatches = useRef<Batch[]>([]);
  const bufVerdict = useRef<CrowdVerdict | null>(null);
  const bufSignals = useRef<CrowdSignals | null>(null);

  const problemsShown = useRef(0);
  const batchesShown = useRef(0);
  const nextAt = useRef(0);
  /** Skip: finish the current segment quickly. */
  const skipping = useRef(false);
  /** When the screen last moved, and whether it has sat waiting on the stream
   *  long enough to offer the founder a way past it. */
  const idleSince = useRef(0);
  const stalledRef = useRef(false);
  /** The stream has closed. One that closed without its last event is not
   *  coming back, so there is no point making the founder wait it out. */
  const runEnded = useRef(false);
  const [stalled, setStalled] = useState(false);
  /** A rewrite run already knows its problems and crowd, so it walks itself
   *  through those segments and slows down for the answers. */
  const auto = useRef(false);
  // The same flag for render; the ref is for the pacing loop's closures.
  const [autoRun, setAutoRun] = useState(false);
  /** Each run owns the screen; a stale stream from an earlier run is ignored. */
  const runToken = useRef(0);

  const personasRef = useRef<DeployedPersona[]>([]);
  /** The saved run this screen is showing, so later beats land on it. */
  const sessionRef = useRef<string | null>(null);
  const parentRef = useRef<string | null>(null);

  const intakeOpen = !booting && (!ventureFile || refine !== null);

  useEffect(() => {
    void detectTier().then(setTier);
    return () => speech.current?.stop();
  }, []);

  const ensureSpeech = useCallback(() => {
    speech.current ??= new SpeechQueue(
      // Playback only needs synthesis, which browsers without speech
      // recognition still have, the "text" tier is about the microphone.
      (text, voice) => speak(text, voice, tier === "elevenlabs" ? "elevenlabs" : "browser"),
      () => {}
    );
    return speech.current;
  }, [tier]);

  // ---------------------------------------------------------------- the run
  const run = useCallback((opts: RunOptions = {}) => {
    // Read the store directly: the intake writes the file and calls run() in
    // the same tick, before any re-render could hand this callback the new file.
    const vf = useVenture.getState().ventureFile;
    if (!vf) return;

    speech.current?.clear();
    // The report grades from the crowd and the committee; never let it grade
    // this run with the last one's.
    useVenture.setState({ crowd: null, deliberation: null });
    stalledRef.current = false;
    setStalled(false);
    runEnded.current = false;
    const token = ++runToken.current;
    const pending = useVenture.getState().pending;
    const sessionId = useSessions.getState().begin(
      vf.solution,
      opts.parentId,
      pending?.name
    );
    sessionRef.current = sessionId;
    parentRef.current = opts.parentId ?? null;
    auto.current = Boolean(opts.parentId);
    setAutoRun(auto.current);
    skipping.current = false;
    nextAt.current = 0;

    bufProblems.current = [];
    bufPersonas.current = [];
    bufBatches.current = [];
    bufVerdict.current = null;
    bufSignals.current = null;
    problemsShown.current = 0;
    batchesShown.current = 0;
    personasRef.current = [];

    setSegment("split");
    setProblemPopup(true);
    setExpecting(0);
    setDeployReady(false);
    setProblems([]); setPersonas([]); setReactions(new Map());
    setVerdict(null); setSignals(null); setShowReveal(false); setFocus(null); setCallReport([]);
    // A fresh run should not carry the previous run's calls into the
    // boardroom, where they would look like evidence for the new pitch.
    useVenture.getState().setCallReport([]);
    setProgress({ done: 0, total: 0 });
    setHubRanking([]);
    setDelta(null);
    setWalkedInWith(opts.parentId ? (opts.walkedInWith ?? null) : null);

    const fail = () => {
      if (token !== runToken.current) return;
      setSegment("idle");
      useSessions.getState().remove(sessionId);
    };

    void streamPost(
      "/api/discovery/run",
      {
        solution: vf.solution,
        crowdSize: 120,
        problems: opts.problems,
        personaIds: opts.personaIds,
        founderProblem: opts.founderProblem,
      },
      (ev) => {
        if (token !== runToken.current) return;
        switch (ev.type) {
          case "problems":
            bufProblems.current = ev.problems as ProblemStatement[];
            setExpecting(bufProblems.current.length);
            break;
          case "deploy":
            bufPersonas.current = ev.personas as DeployedPersona[];
            setConsumer(Boolean(ev.consumer));
            break;
          case "reactions":
            bufBatches.current.push({
              done: ev.done as number,
              total: ev.total as number,
              batch: ev.batch as CrowdReaction[],
            });
            break;
          case "verdict": {
            const v = ev.verdict as CrowdVerdict;
            const sig = ev.signals as CrowdSignals;
            bufVerdict.current = v;
            bufSignals.current = sig;

            // Saved the moment it exists, whether or not the founder ever
            // presses on to see it.
            const ranking = rankFromCrowd(v, bufPersonas.current);
            useSessions.getState().record(
              {
                ...summariseCrowd(v, sig, bufProblems.current, bufPersonas.current.length),
                topHub: ranking[0]
                  ? { hubId: ranking[0].hubId, fitScore: ranking[0].fitScore }
                  : undefined,
              },
              sessionId
            );
            break;
          }
          case "error":
            fail();
            break;
        }
      }
    ).then(() => {
      if (token === runToken.current) runEnded.current = true;
    }, fail);
  }, []);

  // A project created on the dashboard arrives here already described, so the
  // run starts by itself. Without this the screen sat on a finished venture
  // file with nothing running: pressing "Change" reopened the form with the
  // same text still in it, and Part 2 stayed locked because no problem was
  // ever chosen.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || booting || !ventureFile) return;
    const pending = useVenture.getState().pending;
    if (!pending) return;

    autoStarted.current = true;
    queueMicrotask(() => {
      if (pending.founderProblem) setStatedProblem(pending.founderProblem);
      run({ founderProblem: pending.founderProblem });
      useVenture.getState().setPending(null);
    });
  }, [booting, ventureFile, run]);


  // ---------------------------------------------------------------- playback
  // A 100ms loop moves one item at a time from what has arrived to what is on
  // screen, waiting between items. Polling rather than reacting to arrivals, so
  // a burst from the server can never reset the pacing.
  useEffect(() => {
    if (!PLAYING.includes(segment)) return;

    const showBatch = ({ done, total, batch }: Batch) => {
      setProgress({ done, total });
      setReactions((prev) => {
        const next = new Map(prev);
        for (const r of batch) next.set(r.personaId, r);
        return next;
      });
    };

    // Progress is anything new on screen. Waiting on the founder is not a
    // stall; waiting on the stream is, once it has gone on long enough.
    idleSince.current = performance.now();
    const moved = () => {
      idleSince.current = performance.now();
      if (stalledRef.current) {
        stalledRef.current = false;
        setStalled(false);
      }
    };
    const starved = (now: number) => {
      const ended = runEnded.current;
      if (!stalledRef.current && (ended || now - idleSince.current > STALL_MS)) {
        stalledRef.current = true;
        setStalled(true);
      }
    };

    const tick = () => {
      const now = performance.now();
      if (now < nextAt.current) return;
      const quick = skipping.current;

      if (segment === "split") {
        const all = bufProblems.current;
        if (problemsShown.current < all.length) {
          problemsShown.current += 1;
          setProblems(all.slice(0, problemsShown.current));
          moved();
          nextAt.current = now + (quick || auto.current ? 150 : PACE.problem);
        } else if (all.length === 0) {
          starved(now);
        } else if (auto.current) {
          nextAt.current = now + 400;
          setSegment("deploy");
        }
        return;
      }

      if (segment === "deploy") {
        if (personasRef.current.length === 0) {
          const crowd = bufPersonas.current;
          if (crowd.length === 0) return starved(now);
          moved();
          personasRef.current = crowd;
          setPersonas(crowd);
          // Survives navigating away. The crowd verdict has reactions but no
          // coordinates, so without this the globe comes back empty.
          useVenture.getState().setDeployed(crowd);
          setProgress({ done: 0, total: crowd.length });
          nextAt.current = now + (quick || auto.current ? 500 : PACE.deploy);
        } else if (auto.current) {
          nextAt.current = now + 300;
          setSegment("listen");
        } else {
          setDeployReady(true);
        }
        return;
      }

      // listen, the last segment that plays itself.
      const batches = bufBatches.current;
      if (batchesShown.current < batches.length) {
        showBatch(batches[batchesShown.current]);
        batchesShown.current += 1;
        moved();
        nextAt.current = now + (quick ? 90 : PACE.batch);
      } else if (bufVerdict.current) {
        skipping.current = false;
        setSegment("heard");
      } else {
        starved(now);
      }
    };


    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [segment]);

  const skip = () => {
    skipping.current = true;
    nextAt.current = 0;
    speech.current?.clear();
  };

  /** Everyone has answered: put the market's answer on screen. */
  const revealResult = useCallback(() => {
    const v = bufVerdict.current;
    if (!v) return;
    setVerdict(v);
    setSignals(bufSignals.current);
    useVenture.getState().setCrowd(v, bufSignals.current);
    setHubRanking(rankFromCrowd(v, personasRef.current));

    const saved = useSessions.getState().sessions;
    const mine = saved.find((s) => s.id === sessionRef.current);
    const parent = parentRef.current ? saved.find((s) => s.id === parentRef.current) : undefined;
    setDelta(mine && parent ? diffSessions(parent, mine) : null);

    setSegment("result");
    // Nobody claiming a problem is an outcome with plenty to say, not a reason
    // to show nothing.
    setTimeout(() => setShowReveal(true), 200);
  }, []);

  /** Accept the market's problem and carry it into Part 2. */
  const acceptMarketProblem = useCallback(() => {
    if (!ventureFile || !verdict?.marketProblemId) return;
    const chosen = problems.find((p) => p.id === verdict.marketProblemId);
    if (!chosen) return;

    // Whatever Part 1 established travels with it. The committee reads exactly
    // these fields, so the handoff needs no new contract. The strongest city
    // still goes, measured off the crowd rather than argued over: it is the
    // first thing a partner asks after "who has this problem".
    const top = hubRanking[0];

    replaceVenture({
      ...ventureFile,
      version: ventureFile.version + 1,
      extractedProblems: problems,
      chosenProblem: chosen,
      hubFindings: top
        ? {
            ...ventureFile.hubFindings,
            [top.hubId]: {
              hubId: top.hubId,
              fitScore: top.fitScore,
              verdicts: [],
              gapSummary: `${top.haveIt} of the ${top.asked} people asked in ${hubName(
                top.hubId
              )} have this problem${top.wouldPay > 0 ? `, and ${top.wouldPay} would pay to fix it` : ""}.`,
              incumbents: [],
              unserved: "",
            },
          }
        : ventureFile.hubFindings,
    });
  }, [ventureFile, verdict, problems, replaceVenture, hubRanking]);

  /** Rewrite the pitch around the market's problem, for the founder to edit. */
  const startRefine = useCallback(async () => {
    const vf = useVenture.getState().ventureFile;
    const market = problems.find((p) => p.id === verdict?.marketProblemId);
    if (!vf || !market || !sessionRef.current) return;

    setRefining(true);
    const draft = await fetch("/api/discovery/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ solution: vf.solution, problem: market }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { solution?: string } | null) => j?.solution)
      .catch(() => undefined);
    setRefining(false);
    setShowReveal(false);

    setRefine({
      draft: draft || vf.solution,
      target: market,
      parentId: sessionRef.current,
      // The adopted problem leads, so it is what the founder is now pitching.
      problems: [market, ...problems.filter((p) => p.id !== market.id)],
      personaIds: personasRef.current.map((p) => p.id),
      walkedInWith:
        walkedInWith ?? problems.find((p) => p.id === verdict?.pitchedProblemId)?.statement ?? null,
    });
  }, [problems, verdict, walkedInWith]);

  /** Part 1 closes the doors; Part 2 opens them. */
  const walkThroughDoor = useCallback(() => {
    setShowReveal(false);
    setDoor("open");
    setTimeout(() => setDoor("closed"), 40);
    setTimeout(() => {
      armDoor();
      router.push("/committee");
    }, 40 + DOOR_MS + 200);
  }, [router]);

  const enterCommittee = useCallback(() => {
    acceptMarketProblem();
    walkThroughDoor();
  }, [acceptMarketProblem, walkThroughDoor]);

  /**
   * Straight to Part 2 with whatever Part 1 has established. For a stream that
   * never came back, or a market that has none of the candidate problems. The
   * committee already treats a missing validation as a finding rather than
   * refusing to sit, so nothing is invented to get there.
   */
  const forceCommittee = useCallback(() => {
    const vf = useVenture.getState().ventureFile;
    if (!vf) return;
    // Late events from the stream land on nothing.
    runToken.current++;
    speech.current?.clear();

    if (verdict?.marketProblemId) {
      acceptMarketProblem();
    } else {
      replaceVenture({
        ...vf,
        version: vf.version + 1,
        extractedProblems: problems.length > 0 ? problems : vf.extractedProblems,
        // Cleared rather than kept: a problem chosen in an earlier run was not
        // validated by this one.
        chosenProblem: undefined,
        pvs: undefined,
      });
    }
    walkThroughDoor();
  }, [verdict, acceptMarketProblem, replaceVenture, problems, walkThroughDoor]);

  /** Past a stream that has stopped arriving, keeping everything that came. */
  const moveOn = () => {
    stalledRef.current = false;
    setStalled(false);
    speech.current?.clear();

    if (segment === "listen" && bufBatches.current.length > 0) {
      // Grade the people who did answer. The remainder, if it ever arrives,
      // is dropped with the run token.
      runToken.current++;
      const answered = bufBatches.current.flatMap((b) => b.batch);
      const v = aggregate(answered, bufProblems.current);
      bufVerdict.current = v;
      bufSignals.current = null;
      if (sessionRef.current) {
        const ranking = rankFromCrowd(v, personasRef.current);
        useSessions.getState().record(
          {
            ...summariseCrowd(v, null, bufProblems.current, answered.length),
            topHub: ranking[0] ? { hubId: ranking[0].hubId, fitScore: ranking[0].fitScore } : undefined,
          },
          sessionRef.current
        );
      }
      revealResult();
      return;
    }

    // Nothing usable arrived at all.
    forceCommittee();
  };

  // Newest stage sits at the top of the sidebar, so the next thing to do is
  // always on screen. Scroll up when a new one arrives.
  const stageKey = `${hubRanking.length > 0}|${segment}`;
  useEffect(() => {
    asideRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [stageKey]);

  useEffect(() => {
    // The reveal's button goes straight through the door, so the route is
    // warmed while the founder is still reading the card.
    if (segment === "result") router.prefetch("/committee");
  }, [segment, router]);

  // ---------------------------------------------------------------- derived
  const listening = segment === "listen";
  const answered = segment !== "idle" && !PLAYING.slice(0, 3).includes(segment);

  const visible = onlyEngaged
    ? personas.filter((p) => reactions.get(p.id)?.attention === "full")
    : personas;

  const dots: GlobeDot[] = visible.map((p) => {
    const r = reactions.get(p.id);
    return {
      id: `p${p.id}`,
      lat: p.lat,
      lon: p.lon,
      // Names live on the place layer, anchored at the city itself. Tagging one
      // arbitrary dot in a cluster prints the name over its own neighbours.
      label: "",
      stance: r ? r.sentiment * 2 - 1 : undefined,
      weight: r?.attention === "full" ? 0.8 : r?.attention === "partial" ? 0.45 : 0.2,
      active: listening && !r,
      figure: p.figure,
    };
  });

  // One marker per city that actually has someone in it, sized by how many, so
  // the collision layout keeps the crowded places and drops the sparse ones.
  const places: GlobePlace[] = (() => {
    const counts = new Map<string, number>();
    for (const p of visible) counts.set(p.hubId, (counts.get(p.hubId) ?? 0) + 1);

    return [...counts.entries()]
      .map(([hubId, n]): GlobePlace | null => {
        const hub = hubById(hubId);
        if (!hub) return null;
        return {
          id: hubId,
          name: hub.label,
          lat: hub.lat,
          lon: hub.lon,
          weight: n,
          // Once the crowd has answered, the city the problem lands hardest in
          // is lit. Before that, no city is more interesting than another.
          active: segment === "result" && hubRanking[0]?.hubId === hubId,
        };
      })
      .filter((p): p is GlobePlace => p !== null);
  })();

  const stages = deriveStages(segment, Boolean(ventureFile));

  // What the run means, in words. It was written for the report and rendered
  // only there, after the committee. A founder needs it the moment the crowd
  // has answered, which is here.
  const advice = useMemo(
    () => (verdict ? assess(verdict, signals) : null),
    [verdict, signals]
  );

  // The bet on screen: what was pitched until the crowd answers, then what
  // they actually said they have.
  const marketProblem = problems.find((p) => p.id === verdict?.marketProblemId);
  const pitchedProblem = problems.find((p) => p.id === verdict?.pitchedProblemId);
  const marketVote = verdict?.problemVotes.find((v) => v.problemId === verdict.marketProblemId);
  const bet = marketProblem ?? problems.find((p) => p.id === verdict?.pitchedProblemId) ?? problems[0];
  const betIsMarket = Boolean(marketProblem && marketProblem.id !== verdict?.pitchedProblemId);
  /** Only before anyone has answered: after that, an edit would be a new run. */
  const canRewriteBet = problems.length > 0 && !verdict && reactions.size === 0;

  /** Opening a call hands the floor to the person on it: the narrator stops
   *  mid-sentence rather than talking over their hello. */
  const openCall = useCallback(
    (personaId: number) => {
      // The narrator stops mid sentence rather than talking under a hello.
      ensureSpeech().drop("narrator");
      setFocus(personaId);
    },
    [ensureSpeech]
  );

  const endCall = useCallback(() => {
    speech.current?.drop("call");
    setFocus(null);
  }, []);

  /** One of the other framings, tested in place of the current one. */
  /** The founder's own wording for their claim. Same run, same people, their
   *  sentence: the test is only fair if the bet is theirs. */
  const useProblem = useCallback(
    (chosen: { id: string }) => {
      const rest = problems.filter((p) => p.id !== chosen.id);
      const picked = problems.find((p) => p.id === chosen.id);
      if (picked) run({ problems: [picked, ...rest] });
    },
    [problems, run]
  );

  const focused = focus ? personas.find((p) => p.id === focus) : null;
  /** Step two: the problem, centred on the globe. Nothing else is on screen. */
  const splitView = segment === "split";
  // Centred on the globe. The column that used to sit under the caption was
  // four problem cards deep; it is one card at the top now, so nothing is in
  // the way and the line belongs in the middle.
  const centreClear = { left: "50%", maxWidth: "calc(100% - 48px)" };
  const firmName = FIRMS[firmId]?.name ?? "the firm";
  const topCity = hubRanking[0] ? hubName(hubRanking[0].hubId) : null;
  const cities = new Set(personas.map((p) => p.hubId)).size;

  // Live attention while people are still answering.
  const live = { full: 0, partial: 0, ignore: 0 };
  for (const r of reactions.values()) live[r.attention]++;

  // Everything the evidence column needs, computed once so the sidebar and
  // the reveal read the same numbers. reactions is a Map in arrival order;
  // joined against personas here so MarketEvidence never has to know either
  // page's own shape for a person.
  const evidenceReactions: EvidenceReaction[] = useMemo(
    () =>
      [...reactions.values()].map((r) => {
        const p = personas.find((x) => x.id === r.personaId);
        return {
          personaId: r.personaId,
          name: p?.name ?? "Someone",
          title: p?.label ?? p?.title ?? "",
          attention: r.attention,
          reason: r.reason,
          problemId: r.problemId,
          wouldPay: r.wouldPay,
        };
      }),
    [reactions, personas]
  );

  /** Handed to the sidebar and to the reveal's second column alike, so the
   *  case for the pitch reads the same wherever it is shown. The sidebar adds
   *  its own onSelectReaction; the reveal leaves the list read-only rather
   *  than open a call panel on top of a modal that is already on top of the
   *  globe. */
  const evidenceProps: MarketEvidenceProps = {
    advice,
    bet: marketProblem ?? pitchedProblem,
    asked: verdict?.reactions.length ?? 0,
    have: marketVote?.votes ?? 0,
    payRate: marketVote?.payRate ?? 0,
    severity: marketVote?.meanSeverity ?? 0,
    hubRanking,
    hubName,
    counts: verdict ? verdict.attention : live,
    total: personas.length,
    hasCrowd: Boolean(verdict) || reactions.size > 0,
    emptyCrowdCopy:
      personas.length > 0
        ? `${personas.length} people chosen. Nobody has answered yet.`
        : "Nobody asked yet.",
    sentimentSpread: verdict?.sentimentSpread,
    stanceFilter,
    onFilterChange: setStanceFilter,
    signals,
    callReport,
    reactions: evidenceReactions,
    answered,
    listening,
  };

  // The crowd being sent out: one arc from Hack the North to every city in
  // it, launched in sequence, cleared once everyone has answered.
  const arcsOn = segment === "deploy" || segment === "listen";
  const arcs: GlobeArc[] = useMemo(() => {
    if (!arcsOn || personas.length === 0) return [];
    const hubs = [...new Set(personas.map((p) => p.hubId))];
    return hubs.flatMap((id, i) => {
      const to = hubById(id);
      return to && to.id !== "waterloo"
        ? [{ id: `deploy:${id}`, from: HOME, to, delay: i * 90 }]
        : [];
    });
  }, [arcsOn, personas]);

  // ---- the guide: what is happening, and the one thing to do next -------
  const guide = ((): { step: number; title: string; line: string } => {
    if (!ventureFile) {
      return {
        step: 1,
        title: "Product",
        line: "Describe what you built. The market decides which problem it solves.",
      };
    }
    switch (segment) {
      case "split":
        return expecting > 0 && problems.length >= expecting
          ? {
              step: 2,
              title: "Problem",
              // Says where the reading landed and what to do next. It used to
              // say "rewrite it if it is not your claim", which pointed at a
              // card that is no longer on this step; the other framings are in
              // the rail, under the solution, and that is where to swap.
              line: "Your idea has been read for the problem it implies. The other problems it could be sold against are listed on the left. Next, choose who to ask.",
            }
          : {
              step: 2,
              title: "Problem",
              line: "Reading the pitch for the problem it claims somebody has.",
            };
      case "deploy":
        return deployReady
          ? {
              step: 3,
              title: "Sample",
              line: consumer
                ? `${personas.length} people across ${cities} cities, asked as themselves rather than in their job. Select anyone to speak with them.`
                : `${personas.length} people across ${cities} cities whose work touches this, many with budget authority. Select anyone to speak with them.`,
            }
          : {
              step: 3,
              title: "Sample",
              line: "Selecting who should be asked.",
            };
      case "listen":
        return {
          step: 4,
          title: "Responses",
          line: `Each person is asked which problem they have, not whether they like the product. ${progress.done} of ${progress.total || personas.length} have answered.`,
        };
      case "heard":
        return {
          step: 4,
          title: "Responses",
          line: "Everyone has answered. Ready to see what the market said.",
        };
      case "result": {
        // Still step four: asking them and hearing the answer are one step now.
        // The title is what the card says, not a step name, because there is
        // no Result step on the rail for it to echo.
        if (!verdict?.marketProblemId) {
          return {
            step: 4,
            title: "What the market said",
            line: "Nobody we asked claimed any of these problems. That is a finding in itself.",
          };
        }
        // Where it sells is part of the answer, so the line says it rather
        // than making the founder read it off the panel.
        const where = topCity ? ` It lands hardest in ${topCity}.` : "";
        return verdict.mismatch
          ? {
              step: 4,
              title: "What the market said",
              // In words. "You pitched p1. The market has p2" read out schema
              // ids to an audience that has never seen the schema.
              line: `The market has a different problem from the one you pitched, and ${Math.round((marketVote?.payRate ?? 0) * 100)}% of those who have it would pay to fix it.${where} Take it to the venture capitalists when you are ready.`,
            }
          : {
              step: 4,
              title: isRerun ? "What the market said · run two" : "What the market said",
              line: `The market has the problem you pitched.${where} Take it to the venture capitalists when you are ready.`,
            };
      }
      default:
        return {
          step: 1,
          title: "Ready",
          line: "Your idea is read for the problem it implies, then 120 people are asked which problem they actually have.",
        };
    }
  })();

  const next: NextStep | null = !ventureFile
    ? null
    : segment === "idle"
      ? "run"
      : segment === "split"
        ? expecting > 0 && problems.length >= expecting && !autoRun
          ? "choose"
          : "splitting"
        : segment === "deploy"
          ? deployReady
            ? "ask"
            : "choosing"
          : segment === "listen"
            ? "listening"
            : segment === "heard"
              ? "show"
              : marketProblem
                ? "committee"
                : "rerun";

  const nextLabel: Record<NextStep, string> = {
    run: "Ask the market",
    splitting: "Reading your idea…",
    choose: "Next: choose who to ask →",
    choosing: "Choosing who to ask…",
    ask: "Next: ask them →",
    listening: `Listening · ${progress.done}/${progress.total || personas.length || 120}`,
    show: "Show me what they said →",
    rerun: "Run again",
    committee: "Take it to venture capitalists →",
  };

  // Offered, never forced: a slow model looks exactly like a stuck one.
  const stuck = stalled && PLAYING.includes(segment);

  // ---- the narrator, out loud: each new line once, never over a call, never
  // before the founder has clicked.
  const narratorLine = stuck ? STALL_LINE : guide.line;
  const inCall = Boolean(focused);
  useEffect(() => {
    if (!narratorOn || inCall) {
      speech.current?.drop("narrator");
      // Muted: forget what was said, so unmuting reads the current line.
      if (!narratorOn) narrated.current = "";
      return;
    }
    if (booting || intakeOpen) return;
    const key = narrationKey(guide.title, narratorLine);
    if (key === narrated.current) return;
    narrated.current = key;
    if (!mayStartSpeaking()) return;
    ensureSpeech().replace(`narr:${key}`, "narrator", narratorLine);
  }, [narratorOn, inCall, booting, intakeOpen, guide.title, narratorLine, ensureSpeech]);
  const moveOnLabel =
    segment === "listen" && progress.done > 0
      ? `Grade the ${progress.done} who answered ▸`
      : "Skip to the committee ▸";

  const nextDisabled =
    next === "splitting" ||
    next === "choosing" ||
    next === "listening" ||
    (next === "committee" && !marketProblem);

  const takeNextStep = () => {
    switch (next) {
      case "run":
      case "rerun":
        run();
        break;
      case "choose":
        nextAt.current = 0;
        setSegment("deploy");
        break;
      case "ask":
        nextAt.current = 0;
        setSegment("listen");
        break;
      case "show":
        revealResult();
        break;
      case "committee":
        // Adopt the market's problem on the way out, so the file the partners
        // read says what the crowd said rather than what was pitched.
        enterCommittee();
        break;
    }
  };

  const panel =
    segment === "split"
      ? { step: "Reading your idea", unit: "Framings weighed", done: problems.length, total: expecting || 4 }
      : segment === "deploy"
        ? { step: "Choosing who to ask", unit: "People chosen", done: personas.length, total: personas.length || 120 }
        : segment === "listen"
          ? { step: "Listening", unit: "People answered", done: progress.done, total: progress.total || personas.length }
          : null;

  return (
    <main className="relative h-screen overflow-hidden bg-ground text-ink">
      <SmallScreenNotice />
      {booting && (
        <AgentBoot
          steps={MARKET_STEPS}
          tagline="see the problem"
          onComplete={() => {
            booted = true;
            setBooting(false);
          }}
        />
      )}
      <AnimatePresence>
        {intakeOpen && (
          <Intake
            key={refine ? "refine" : "new"}
            cta={refine ? "Ask them again" : "Ask the market"}
            refine={
              refine
                ? {
                    draft: refine.draft,
                    target: refine.target,
                    crowd: refine.personaIds.length,
                    problems: refine.problems.length,
                  }
                : undefined
            }
            onCancel={
              refine
                ? () => {
                    setRefine(null);
                    setShowReveal(true);
                  }
                : undefined
            }
            onDone={(_solution, founderProblem) => {
              const r = refine;
              setRefine(null);
              // Refine mode has no problem box, so leave run one's answer alone
              // rather than blanking it with an undefined.
              if (!r) setStatedProblem(founderProblem?.trim() || null);
              run(
                r
                  ? {
                      problems: r.problems,
                      personaIds: r.personaIds,
                      parentId: r.parentId,
                      walkedInWith: r.walkedInWith,
                    }
                  : { founderProblem }
              );
            }}
          />
        )}
      </AnimatePresence>

      <div className="flex h-full">
        <StageRail
          state={stages}
          solution={ventureFile?.solution}
          rerun={isRerun}
          onReset={() => resetVenture()}
          projectName={activeProject?.name}
          onRename={
            activeProject
              ? (name) => useSessions.getState().rename(activeProject.id, name)
              : undefined
          }
          under={
            bet && problems.length > 1 ? (
              <OtherProblems
                problems={problems.filter((p) => p.id !== bet.id)}
                onUse={canRewriteBet ? useProblem : undefined}
              />
            ) : null
          }
          onJump={(id) => {
            if (id === "listen" && marketProblem && pitchedProblem) setShowReveal(true);
            if (id === "pitch" && marketProblem) enterCommittee();
          }}
        />

        <div className="relative flex-1">
          <Globe
            dots={dots}
            places={places}
            onDotClick={(id) => openCall(Number(id.slice(1)))}
            // Whoever you are talking to waves hello, from the globe or the list.
            selected={focus ? `p${focus}` : null}
            // Hack the North in view while the idea is split and sent out. Not
            // dead centre: every great circle through the point under the
            // camera projects as a straight line, so from directly above
            // Waterloo the arcs fanned out as a starburst of rays. From due
            // south they read as the arcs they are, and Waterloo sits top
            // centre, clear of the panels either side.
            focus={
              // Whoever you are talking to is turned into the upper half of
              // the globe: the call card opens over the lower half, and a
              // hello nobody can see is no hello.
              focused
                ? { lat: Math.max(-70, focused.lat - 18), lon: focused.lon }
                : segment === "split" || segment === "deploy"
                  ? { lat: HOME.lat - 28, lon: HOME.lon }
                  : null
            }
            // Deliberately not turned to the strongest city at the result. The
            // globe's place labels are laid out against each other, not against
            // the caption underneath it, so turning a new city into the bottom
            // of the sphere printed its name straight through the narrator's.
            // "Where it lands" names the city, in the panel, where it reads.
            beacon={null}
            arcs={arcs}
            className="h-full w-full"
          />

          {/* ---------------------------------------------------- narrator */}
          {/* Sits on the action it explains: what is happening, then the button. */}
          {!intakeOpen && !focused && (
            <div
              className="absolute bottom-[76px] z-30 w-[520px] -translate-x-1/2"
              style={centreClear}
            >
              <Narrator
                step={guide.step}
                title={guide.title}
                line={narratorLine}
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

          {/* ---------------------------------------------------- top left */}
          <AnimatePresence>
            {splitView && problemPopup && panel && (
              <ProblemPopup
                key="problems"
                loading={problems.length === 0 || problems.length < expecting}
                step={panel.step}
                solution={ventureFile?.solution}
                problem={statedProblem ?? undefined}
                others={bet ? problems.filter((p) => p.id !== bet.id) : []}
                onClose={() => setProblemPopup(false)}
              />
            )}
          </AnimatePresence>

          <div className="absolute left-6 top-6 z-40 w-[300px]">
            <AnimatePresence mode="wait">
              {panel && !splitView && (
                <ProcessingPanel
                  key="proc"
                  step={panel.step}
                  done={panel.done}
                  total={panel.total}
                  unit={panel.unit}
                />
              )}
            </AnimatePresence>

            {/* One bet, not four cards. The rivals are still asked about,
                because the crowd choosing one of them is the pivot.

                Only once the crowd has answered, and only if they claimed
                something. Earlier it printed the sentence the pop-up had just
                shown, beside a globe of people who had not been asked yet —
                two answers to one question, and the second one guesswork. With
                nobody claiming a problem there is nothing to say they struggle
                with, so it stays away then too. */}
            {marketProblem && segment === "result" && (
              <div className="mt-4 space-y-1.5">
                <p className="label">What they actually struggle with</p>
                <Bet
                  problem={marketProblem}
                  label="Their problem, in their words"
                  isMarket={betIsMarket}
                  vote={verdict?.problemVotes.find((v) => v.problemId === marketProblem.id)}
                />
              </div>
            )}
          </div>

          {/* --------------------------------------------- call one person */}
          <AnimatePresence>
            {focused && ventureFile && (
              <PersonaCall
                key={focused.id}
                persona={focused}
                reaction={reactions.get(focused.id)}
                solution={ventureFile.solution}
                problems={problems}
                centre={centreClear.left}
                queue={ensureSpeech}
                onSummarise={(entry) =>
                  setCallReport((r) => {
                    const next = [
                      { ...entry, at: Date.now() },
                      ...r.filter((e) => e.personaId !== entry.personaId),
                    ];
                    // Mirrored into the shared store so a call made here is
                    // still on hand once the founder is in the boardroom.
                    useVenture.getState().setCallReport(next);
                    return next;
                  })
                }
                onClose={endCall}
              />
            )}
          </AnimatePresence>

          {/* ---------------------------------------------------- controls */}
          {/* One button, always the next step. Its label says what happens. */}
          <div className="absolute bottom-6 z-40 -translate-x-1/2" style={{ left: centreClear.left }}>
            <div className="panel flex items-center gap-1 whitespace-nowrap p-1.5">
              {next && (
                <button
                  onClick={takeNextStep}
                  disabled={nextDisabled}
                  className={`bg-accent px-5 py-2 font-mono text-[13px] uppercase tracking-[0.14em] text-ground transition hover:brightness-110 disabled:bg-edge disabled:text-faint ${
                    nextDisabled ? "" : "beam"
                  }`}
                >
                  {nextLabel[next]}
                </button>
              )}

              {PLAYING.includes(segment) && (
                <button
                  onClick={skip}
                  title="Finish this step now"
                  className="px-3 py-2 font-mono text-[13px] uppercase tracking-[0.14em] text-faint transition hover:text-ink"
                >
                  Skip ▸▸
                </button>
              )}

              {stuck && (
                <button
                  onClick={moveOn}
                  title="Nothing new has arrived for a while. Carry on with what did."
                  className="px-3 py-2 font-mono text-[13px] uppercase tracking-[0.14em] transition hover:brightness-125"
                  style={{ color: "var(--caution)" }}
                >
                  {moveOnLabel}
                </button>
              )}

              {/* Nobody in the crowd had any of the problems. Run again is the
                  honest next step, but not the only one on stage. */}
              {segment === "result" && verdict && !verdict.marketProblemId && (
                <button
                  onClick={forceCommittee}
                  className="px-3 py-2 font-mono text-[13px] uppercase tracking-[0.14em] text-muted transition hover:text-ink"
                >
                  Take it to the committee anyway →
                </button>
              )}

              {segment === "result" && verdict?.mismatch && (
                <button
                  onClick={() => void startRefine()}
                  disabled={refining}
                  className="px-3 py-2 font-mono text-[13px] uppercase tracking-[0.14em] text-muted transition hover:text-ink disabled:opacity-50"
                >
                  {refining ? "Rewriting…" : "Rewrite · ask again"}
                </button>
              )}

              {segment === "result" && next !== "rerun" && (
                <button
                  onClick={() => run()}
                  className="px-3 py-2 font-mono text-[13px] uppercase tracking-[0.14em] text-faint transition hover:text-ink"
                >
                  Run again
                </button>
              )}

              {personas.length > 0 && answered && (
                <button
                  onClick={() => setOnlyEngaged((v) => !v)}
                  className={`px-3 py-2 font-mono text-[13px] uppercase tracking-[0.14em] transition ${
                    onlyEngaged ? "text-accent" : "text-muted hover:text-ink"
                  }`}
                >
                  {onlyEngaged ? "Engaged only" : "All"}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------- sidebar */}
        {/* Newest stage first: the conclusion, then the evidence under it. */}
        <aside
          ref={asideRef}
          className="flex w-96 shrink-0 flex-col overflow-y-auto border-l border-edge bg-surface/40"
        >
          <MarketEvidence {...evidenceProps} onSelectReaction={openCall} />
        </aside>
      </div>

      {/* ------------------------------------------------------- THE REVEAL */}
      <AnimatePresence>
        {showReveal && pitchedProblem && verdict && (
          <Reveal
            pitched={pitchedProblem}
            market={marketProblem ?? null}
            noMarket={marketProblem ? null : diagnoseNoMarket(verdict, pitchedProblem)}
            aligned={!verdict.mismatch}
            delta={delta}
            crowd={personas.length}
            problemCount={problems.length}
            advice={advice}
            evidence={evidenceProps}
            refining={refining}
            onAccept={enterCommittee}
            onRefine={() => void startRefine()}
            onClose={() => setShowReveal(false)}
            onAnyway={forceCommittee}
          />
        )}
      </AnimatePresence>

      {door !== "none" && <Door state={door} title="The committee" subtitle={firmName} />}
    </main>
  );
}

