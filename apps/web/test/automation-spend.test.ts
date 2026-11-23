import { describe, expect, it } from "vitest";
import { spendText } from "@/components/automations/automation-spend";

const base = { automationId: "a", name: "n", sessions: 1 };

describe("spendText", () => {
  it("says when nothing was spent", () => {
    expect(spendText(undefined)).toBe("No spend in the last 30 days");
    expect(spendText({ ...base, costUsd: 0, estimatedCostUsd: 0 })).toContain("No spend");
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
});
