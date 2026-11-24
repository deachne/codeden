import { describe, expect, it } from "vitest";
import { ProposePlanInput, Settings, StartPlannerResponse } from "../src";

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
    const handOff = { vision: "# Vision\n", plan: "# Plan\n" };
    expect(roundTrip(ProposePlanInput, handOff)).toEqual(handOff);
  });

  it("refuses an empty vision or plan", () => {
    expect(ProposePlanInput.safeParse({ vision: "", plan: "# Plan\n" }).success).toBe(false);
    expect(ProposePlanInput.safeParse({ vision: "# Vision\n" }).success).toBe(false);
  });
});
