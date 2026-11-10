import { describe, expect, it } from "vitest";
import type { AgentVerdict, Objection } from "@/lib/types";
import {
  buildVerdict,
  computeScore,
  decide,
  detectDissents,
  normalizeWeights,
  voteShares,
  stanceVariance,
  type WeightMap,
} from "@/lib/verdict";

const WEIGHTS: WeightMap = { gp: 0.5, principal: 0.3, skeptic: 0.2 };

function vote(
  agentId: string,
  stance: number,
  confidence = 0.8
): AgentVerdict {
  return {
    agentId,
    stance,
    confidence,
    position: "",
    reasoning: "",
    evidence: [],
    whatWouldChangeMyMind: "",
  };
}

describe("normalizeWeights", () => {
  it("sums to 1", () => {
    const n = normalizeWeights({ a: 3, b: 1 });
    expect(n.a + n.b).toBeCloseTo(1);
    expect(n.a).toBeCloseTo(0.75);
  });

  it("falls back to an even split when all weights are zeroed", () => {
    const n = normalizeWeights({ a: 0, b: 0 });
    expect(n.a).toBeCloseTo(0.5);
    expect(n.b).toBeCloseTo(0.5);
  });
});

describe("voteShares", () => {
  // The room as it actually sits: three partners, the outsider, the chair.
  const room = { gp: 0.5, principal: 0.3, skeptic: 0.2, "devils-advocate": 0.1, chair: 0 };

  it("adds up to 100 when the raw weights do not add up to one", () => {
    // Printed raw, these read 50 + 30 + 20 + 10: a room holding 110% of the vote.
    const shares = voteShares(room);
    expect(Object.values(shares).reduce((a, b) => a + b, 0)).toBe(100);
    expect(shares).toEqual({ gp: 46, principal: 27, skeptic: 18, "devils-advocate": 9, chair: 0 });
  });

  it("leaves weights that already add up to one alone", () => {
    expect(voteShares({ gp: 0.5, principal: 0.3, skeptic: 0.2 })).toEqual({
      gp: 50,
      principal: 30,
      skeptic: 20,
    });
  });

  it("gives a room with nobody voting no shares at all", () => {
    expect(voteShares({ chair: 0 })).toEqual({ chair: 0 });
    expect(voteShares({})).toEqual({});
  });
});

describe("computeScore", () => {
  it("weights a heavy seat more than a light one", () => {
    const score = computeScore(
      [vote("gp", 1), vote("principal", -1), vote("skeptic", -1)],
      WEIGHTS
    );
    // gp 0.5 vs the other two 0.5 combined, all equal confidence -> ~0
    expect(score).toBeCloseTo(0, 1);
  });

  it("de-weights a heavy seat that admits low confidence", () => {
    const confident = computeScore(
      [vote("gp", 1, 1.0), vote("skeptic", -1, 1.0)],
      WEIGHTS
    );
    const hedging = computeScore(
      [vote("gp", 1, 0.1), vote("skeptic", -1, 1.0)],
      WEIGHTS
    );
    expect(hedging).toBeLessThan(confident);
  });

  it("penalizes unanswered objections", () => {
    const votes = [vote("gp", 0.8), vote("principal", 0.8), vote("skeptic", 0.8)];
    expect(computeScore(votes, WEIGHTS, 0)).toBeGreaterThan(
      computeScore(votes, WEIGHTS, 3)
    );
  });

  it("never escapes [-1, 1]", () => {
    const votes = [vote("gp", -1), vote("principal", -1), vote("skeptic", -1)];
    expect(computeScore(votes, WEIGHTS, 20)).toBeGreaterThanOrEqual(-1);
  });
});

describe("decide", () => {
  it("maps score bands to decisions", () => {
    expect(decide(0.9)).toBe("invest");
    expect(decide(0.1)).toBe("conditional");
    expect(decide(-0.5)).toBe("pass");
  });
});

describe("dissent", () => {
  it("surfaces a lone hard no in an enthusiastic room", () => {
    const votes = [vote("gp", 0.9), vote("principal", 0.8), vote("skeptic", -0.9)];
    const score = computeScore(votes, WEIGHTS);
    expect(detectDissents(votes, score)).toContain("skeptic");
  });

  it("reports no dissent when the room genuinely agrees", () => {
    const votes = [vote("gp", 0.7), vote("principal", 0.75), vote("skeptic", 0.72)];
    expect(detectDissents(votes, computeScore(votes, WEIGHTS))).toHaveLength(0);
  });
});

describe("stanceVariance", () => {
  // Guards the Huawei story: if the agents collapse into one voice, the
  // multi-agent premise is dead and we need to know at hour 7, not hour 20.
  it("is near zero when agents homogenize", () => {
    const clones = [vote("gp", 0.6), vote("principal", 0.61), vote("skeptic", 0.59)];
    expect(stanceVariance(clones)).toBeLessThan(0.05);
  });

  it("is substantial when agents genuinely disagree", () => {
    const room = [vote("gp", 0.9), vote("principal", 0.1), vote("skeptic", -0.8)];
    expect(stanceVariance(room)).toBeGreaterThan(0.3);
  });
});

describe("buildVerdict", () => {
  it("names the kill shot from the most negative unresolved seat", () => {
    const votes = [vote("gp", 0.5), vote("principal", 0.2), vote("skeptic", -0.9)];
    const objections: Objection[] = [
      {
        id: "o1",
        seatId: "principal",
        text: "CAC payback is unproven.",
        type: "unit-economics",
        status: "open",
        raisedAtTurn: 2,
      },
      {
        id: "o2",
        seatId: "skeptic",
        text: "This is a feature of an existing product, not a company.",
        type: "competitor",
        status: "dodged",
        raisedAtTurn: 4,
      },
    ];

    const v = buildVerdict(votes, WEIGHTS, objections, ["Show retention"], "You have 20 design partners");
    expect(v.killShot).toBe("This is a feature of an existing product, not a company.");
    expect(v.dissents).toContain("skeptic");
  });

  it("leaves the kill shot empty when everything was answered", () => {
    const votes = [vote("gp", 0.6)];
    const answered: Objection[] = [
      {
        id: "o1",
        seatId: "gp",
        text: "Why now?",
        type: "timing",
        status: "answered",
        raisedAtTurn: 1,
        resolvedAtTurn: 2,
      },
    ];
    expect(buildVerdict(votes, WEIGHTS, answered, [], "").killShot).toBeUndefined();
  });
});
