import { describe, expect, it } from "vitest";
import { MAX_OWNER_CHECKS, Notice, ProposePlanInput, Settings, StartPlannerResponse } from "../src";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

// §8.5 The Planner: "Plan with me" and its hand-off, `propose_plan`.
describe("The Planner", () => {
  it("has its own model setting, auto for settings saved before it existed", () => {
    expect(Settings.parse({}).providers.planner).toEqual({
      provider: "auto",
      model: null,
      effort: null,
    });
    const chosen = { provider: "claude", model: "claude-opus-5-5", effort: "high" };
    expect(roundTrip(Settings, { providers: { planner: chosen } }).providers.planner).toEqual(
      chosen,
    );
  });

  it("round-trips the start response and the hand-off", () => {
    expect(roundTrip(StartPlannerResponse, { sessionId: "s-1", status: "existing" })).toEqual({
      sessionId: "s-1",
      status: "existing",
    });
    const handOff = { vision: "# Vision\n", plan: "# Plan\n", ownerChecks: ["I see a summary"] };
    expect(roundTrip(ProposePlanInput, handOff)).toEqual(handOff);
    // Owner checks are optional, and capped like the project's own.
    expect(ProposePlanInput.parse({ vision: "v", plan: "p" }).ownerChecks).toEqual([]);
    const tooMany = Array.from({ length: MAX_OWNER_CHECKS + 1 }, (_, i) => `Check ${i}`);
    expect(
      ProposePlanInput.safeParse({ vision: "v", plan: "p", ownerChecks: tooMany }).success,
    ).toBe(false);
  });

  it("refuses an empty vision or plan", () => {
    expect(ProposePlanInput.safeParse({ vision: "", plan: "# Plan\n" }).success).toBe(false);
    expect(ProposePlanInput.safeParse({ vision: "# Vision\n" }).success).toBe(false);
  });

  it("round-trips the notice that wakes the PM once the plan is approved", () => {
    const notice = {
      id: "plan.approved:p-1:2026-11-24T08:00:00.000Z",
      type: "plan.approved",
      projectId: "p-1",
      target: "pm",
      sessionId: null,
      title: "Plan approved: emoji-it",
      createdAt: "2026-11-24T08:00:00.000Z",
      deliveredAt: null,
      data: { approvedAt: "2026-11-24T08:00:00.000Z", mode: "assisted", hasPlan: true },
    };
    expect(roundTrip(Notice, notice)).toEqual(notice);
  });
});
