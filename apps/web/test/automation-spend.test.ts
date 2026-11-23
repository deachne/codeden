import { describe, expect, it } from "vitest";
import { spendText } from "@/components/automations/automation-spend";
import { costFigureText } from "@/components/usage/format";

const base = { automationId: "a", name: "n", sessions: 1, unpricedTurns: 0 };

describe("spendText", () => {
  it("says when nothing was spent", () => {
    expect(spendText(undefined)).toBe("No spend in the last 30 days");
    expect(spendText({ ...base, costUsd: 0, estimatedCostUsd: 0 })).toContain("No spend");
  });
  it("does not call unpriced work free", () => {
    expect(spendText({ ...base, costUsd: 0, estimatedCostUsd: 0, unpricedTurns: 3 })).toBe(
      "Cost unknown (3 turns unpriced) in the last 30 days",
    );
    expect(spendText({ ...base, costUsd: 1.2, estimatedCostUsd: 0, unpricedTurns: 1 })).toBe(
      "≈ $1.20 + 1 turn unpriced in the last 30 days",
    );
  });
  it("says where the figure comes from", () => {
    expect(spendText({ ...base, costUsd: 1.2, estimatedCostUsd: 0 })).toBe(
      "$1.20 in the last 30 days (reported by the provider)",
    );
    expect(spendText({ ...base, costUsd: 1.2, estimatedCostUsd: 1.2 })).toBe(
      "≈ $1.20 in the last 30 days (estimated by CodeDen)",
    );
    expect(spendText({ ...base, costUsd: 1.2, estimatedCostUsd: 0.4 })).toContain(
      "partly estimated",
    );
  });
  it("uses the same figure text as the Reports page", () => {
    for (const spend of [
      { ...base, costUsd: 0, estimatedCostUsd: 0, unpricedTurns: 3 },
      { ...base, costUsd: 1.2, estimatedCostUsd: 0, unpricedTurns: 1 },
      { ...base, costUsd: 1.2, estimatedCostUsd: 0.4 },
      { ...base, costUsd: 1.2, estimatedCostUsd: 0 },
    ]) {
      expect(spendText(spend)).toContain(costFigureText(spend));
    }
  });
});
