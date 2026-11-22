import type { Session } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { sessionOutcome } from "@/lib/session-outcome";
import { lastFailedTurnError } from "@/lib/transcript/reducer";

const sess = (extra: object) =>
  ({
    id: "s1",
    role: "agent",
    status: "idle",
    result: null,
    startError: null,
    ...extra,
  }) as unknown as Session;

describe("sessionOutcome for idle agents", () => {
  it("shows Done for an idle agent whose last turn completed", () => {
    expect(sessionOutcome(sess({ lastTurnStatus: "completed" }))?.kind).toBe("done");
  });
  it("shows Failed for an idle agent whose last turn failed", () => {
    expect(sessionOutcome(sess({ lastTurnStatus: "failed" }), "bad")?.reason).toBe("bad");
  });
  it("shows nothing for a never-run idle agent", () => {
    expect(sessionOutcome(sess({}))).toBeNull();
  });
});

describe("lastFailedTurnError", () => {
  it("ignores an older failure once a newer turn did not fail", () => {
    const state = {
      threads: { t: { turnIds: ["a", "b"] } },
      turns: {
        a: { status: "failed", error: { message: "old" } },
        b: { status: "completed", error: null },
      },
    } as never;
    expect(lastFailedTurnError(state, "t")).toBeNull();
  });
});

describe("sessionOutcome for other roles", () => {
  it.each(["pm", "orchestrator"])("shows no Done banner for an idle %s", (role) => {
    expect(sessionOutcome(sess({ role, lastTurnStatus: "completed" }))).toBeNull();
  });
  it.each(["pm", "orchestrator"])("shows Failed for an idle %s after a failed turn", (role) => {
    const o = sessionOutcome(sess({ role, lastTurnStatus: "failed" }), "compact failed");
    expect(o).toMatchObject({ kind: "failed", reason: "compact failed" });
  });
  it("keeps the summary and action of an idle finished worker", () => {
    const o = sessionOutcome(
      sess({
        lastTurnStatus: "completed",
        result: { outcome: "success", summary: "All good", nextSteps: ["Review the PR"] },
      }),
    );
    expect(o).toMatchObject({ kind: "done", summary: "All good", action: "Yes: Review the PR" });
  });
});
