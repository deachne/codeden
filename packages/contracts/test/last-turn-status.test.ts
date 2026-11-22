import { describe, expect, it } from "vitest";
import { Session } from "../src";
import { sampleSession } from "./fixtures";

describe("Session.lastTurnStatus", () => {
  it("round-trips each outcome and null", () => {
    for (const lastTurnStatus of ["completed", "failed", "interrupted", null] as const) {
      const back = Session.parse(JSON.parse(JSON.stringify({ ...sampleSession, lastTurnStatus })));
      expect(back.lastTurnStatus).toBe(lastTurnStatus);
    }
  });

  it("is absent on sessions recorded before it existed", () => {
    expect(Session.parse(sampleSession).lastTurnStatus).toBeUndefined();
  });

  it("rejects a turn that is still running", () => {
    expect(() => Session.parse({ ...sampleSession, lastTurnStatus: "running" })).toThrow();
  });
});
