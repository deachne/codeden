import { beforeEach, describe, expect, it } from "vitest";
import { sampleSession } from "./helpers";
import { MemoryProjection } from "./support/memory-projection";

const T = "t-root";
let p: MemoryProjection;

beforeEach(() => {
  p = new MemoryProjection();
  p.addSession({ ...sampleSession, status: "starting", projectId: "p1" });
  p.apply("s1", { type: "thread.started", thread: { id: T } });
});

const failedTurn = (kind: "transient" | "fatal", turnId: string) =>
  [
    { type: "turn.started", threadId: T, turnId },
    {
      type: "turn.failed",
      threadId: T,
      turnId,
      error: { kind, code: "x", message: "boom", retryable: false },
    },
  ] as never[];

describe("lastTurnStatus and startError", () => {
  it("does not mark a turn awaiting automatic retry as failed", () => {
    p.apply("s1", ...failedTurn("transient", "u1"));
    expect(p.session().status).toBe("idle");
    expect(p.session().lastTurnStatus).not.toBe("failed");
  });

  it("clears the previous turn's status when a new turn starts", () => {
    p.apply(
      "s1",
      { type: "turn.started", threadId: T, turnId: "u1" },
      { type: "turn.completed", threadId: T, turnId: "u1" },
    );
    expect(p.session().lastTurnStatus).toBe("completed");
    p.apply("s1", { type: "turn.started", threadId: T, turnId: "u2" });
    expect(p.session().lastTurnStatus ?? null).toBeNull();
  });

  it("clears a stale startError when a turn starts", () => {
    p.addSession({
      ...sampleSession,
      status: "failed",
      startError: { kind: "setup", code: "open_failed", message: "old", retryable: false },
    });
    p.apply("s1", { type: "turn.started", threadId: T, turnId: "u1" });
    expect(p.session().startError ?? null).toBeNull();
  });
});
