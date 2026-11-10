"use client";

import Link from "next/link";
import { useState } from "react";
import { Logo } from "@/components/Logo";

// ============================================================================
// THE GLOBE AND THE BOARDROOM DO NOT FIT ON A PHONE.
//
// Both are three fixed columns around a 3D scene, and on a narrow screen the
// panels land on top of each other with the controls underneath them. Someone
// who opens the link on a phone deserves to be told that, rather than left to
// conclude the product is broken.
//
// Shown by the stylesheet below the lg breakpoint, so it is right on the first
// frame and needs no resize listener. It can be dismissed, because a tablet in
// landscape is narrow by this measure and perfectly usable.
// ============================================================================

export function SmallScreenNotice() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="small-screen-title"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-ground px-8 lg:hidden"
    >
      <div className="w-full max-w-sm">
        <Logo size={36} className="text-ink" />
        <h2 id="small-screen-title" className="headline mt-5 text-4xl text-ink">
          This part needs a wider screen.
        </h2>
        <p className="mt-4 text-sm leading-relaxed text-muted">
          The market globe and the committee room are laid out for a laptop. Open
          this link on one to run the simulation.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link
            href="/"
            className="bg-accent px-5 py-2.5 font-mono text-[13px] uppercase tracking-[0.14em] text-ground transition hover:brightness-110"
          >
            Back to the start
          </Link>
          <button
            onClick={() => setDismissed(true)}
            className="font-mono text-[13px] text-muted underline decoration-edge-bright underline-offset-4 transition hover:text-ink"
          >
            Continue anyway
          </button>
        </div>
      </div>
    </div>
  );
}
