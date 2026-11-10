"use client";

import { BlurWords } from "@/components/BlurWords";
import { Wordmark } from "@/components/Logo";

// ============================================================================
// THE FRONT DOOR, FOR SOMEONE WHO HAS NEVER BEEN HERE.
//
// "/" used to open on an empty list of projects, which told a stranger nothing
// about what this is. Most people who follow the link are strangers: a judge, a
// recruiter, someone handed the URL in a message.
//
// So the first thing they see is the product's own best moment, the reveal,
// with a pitch struck out and the market's answer arriving underneath it. It is
// the same card the app shows at the end of Part 1, built from the same
// classes, and the run on it is a real one from the demo provider. Nothing here
// is a mock-up of something the product does not do.
//
// Once a project exists, this is replaced by the list of them.
// ============================================================================

// One real run of the demo provider, so the numbers on the card are ones the
// app actually produced rather than ones that merely look plausible.
const SAMPLE = {
  pitched: "A self-feeding machine for cats.",
  market:
    "Owners who are out for long or unpredictable days can't keep their cat's routine on track.",
  who: "working cat owners who already pay for sitters, walkers and gadgets",
  have: 30,
  asked: 120,
  wouldPay: 83,
};

// Numbered because it is a sequence: each step consumes what the one before it
// produced, and the app's own stage rail counts them the same way.
const STEPS = [
  {
    title: "Ask the market",
    body: "120 people, drawn from 326 across 20 cities, are each asked which of several problems they actually have. Not whether they like what you built. Call any of them and ask why.",
  },
  {
    title: "Read what they said",
    body: "Your framing is set beside theirs. If they disagree, rewrite the pitch and put it to the same people again. The two runs are compared line by line.",
  },
  {
    title: "Defend it",
    body: "Five partners at one of 25 firms cross-examine you, by voice or by typing. They keep track of what you dodged, argue with each other, and vote.",
  },
];

export function Landing({
  onStart,
  pending,
}: {
  onStart: () => void;
  /** True until hydration. Lets the stylesheet hide this from a returning
   *  founder, whose saved projects are about to replace it. */
  pending: boolean;
}) {
  return (
    <main
      className={`min-h-screen bg-ground text-ink ${pending ? "first-run-pending" : ""}`}
    >
      <div className="mx-auto max-w-6xl px-6 pb-16 pt-8">
        <header className="flex items-center justify-between gap-4">
          <Wordmark size={18} />
          <a
            href="https://github.com/jaineelmodi11/vision"
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[13px] text-muted underline decoration-edge-bright underline-offset-4 transition hover:text-ink"
          >
            Source on GitHub
          </a>
        </header>

        <section className="grid items-center gap-10 pt-12 lg:grid-cols-12 lg:gap-14 lg:pt-20">
          <div className="lg:col-span-6">
            <h1 className="headline text-[clamp(44px,6.2vw,80px)] leading-[1.02] text-ink">
              Which problem are you actually solving?
            </h1>
            <p className="mt-6 max-w-[34rem] text-base leading-relaxed text-muted">
              Describe something you built. A simulated market tells you which
              problem it solves for them, which is often not the one you pitched.
              Then you defend that problem to an investment committee, and they
              vote.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              <button
                onClick={onStart}
                className="beam bg-accent px-6 py-3 font-mono text-[13px] uppercase tracking-[0.14em] text-ground transition hover:brightness-110"
              >
                Ask the market
              </button>
              <a
                href="#how"
                className="font-mono text-[13px] text-muted underline decoration-edge-bright underline-offset-4 transition hover:text-ink"
              >
                How a run goes
              </a>
            </div>
            <p className="mt-5 max-w-[30rem] text-xs leading-relaxed text-faint">
              Free, with no account and no API key. The simulation is laid out for
              a laptop screen.
            </p>
          </div>

          {/* The reveal, as the app shows it. Not a screenshot: the same card. */}
          <figure className="lg:col-span-6">
            <div className="insert p-6 sm:p-8">
              <p className="label">You pitched</p>
              <p className="insert-muted mt-1 text-sm leading-relaxed">
                <span className="strike">{SAMPLE.pitched}</span>
              </p>

              <p
                className="label blur-word mt-6"
                style={{ color: "var(--accent)", animationDelay: "1000ms" }}
              >
                The problem they actually have
              </p>
              <p className="headline mt-2 text-[clamp(26px,3.1vw,36px)]">
                <BlurWords text={SAMPLE.market} delay={1150} />
              </p>
              <p
                className="insert-muted blur-word mt-3 text-xs"
                style={{ animationDelay: "1900ms" }}
              >
                Felt by {SAMPLE.who}
              </p>

              <p
                className="blur-word mt-6 pt-4 text-[15px] leading-relaxed"
                style={{
                  borderTop: "1px solid var(--insert-2)",
                  animationDelay: "2200ms",
                }}
              >
                {SAMPLE.have} of the {SAMPLE.asked} people asked have it, and{" "}
                {SAMPLE.wouldPay}% of those would pay to fix it.
              </p>
            </div>
            <figcaption className="mt-3 text-xs leading-relaxed text-faint">
              A real run, on the built-in demo provider. Yours will read
              differently.
            </figcaption>
          </figure>
        </section>

        <section id="how" className="mt-20 scroll-mt-8 lg:mt-28">
          <div className="rule" />
          <h2 className="mt-8 font-mono text-xl text-ink">How a run goes</h2>

          <ol className="mt-8 grid gap-x-10 gap-y-8 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-4 md:block">
                <span
                  aria-hidden
                  className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent text-[13px] text-accent"
                >
                  {i + 1}
                </span>
                <div>
                  <h3 className="text-lg leading-snug text-ink md:mt-4">
                    {step.title}
                  </h3>
                  <p className="mt-2 max-w-[26rem] text-sm leading-relaxed text-muted">
                    {step.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-12">
            <button
              onClick={onStart}
              className="border border-edge-bright px-5 py-2.5 font-mono text-[13px] uppercase tracking-[0.14em] text-ink transition hover:bg-surface-2"
            >
              Ask the market
            </button>
          </div>
        </section>

        <footer className="mt-20 text-xs leading-relaxed text-faint">
          <div className="rule mb-5" />
          <p>
            Final round at Hack the North 2026. An AI simulation, not affiliated
            with or endorsed by any firm named in it.
          </p>
        </footer>
      </div>
    </main>
  );
}
