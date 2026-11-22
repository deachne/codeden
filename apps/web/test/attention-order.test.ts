import type { Session } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { sortSessionsByAttention } from "@/lib/session-order";
import { sessionOutcome } from "@/lib/session-outcome";

const s = (id: string, status: Session["status"], updatedAt: string, extra = {}) =>
  ({
    id,
    status,
    updatedAt,
    endedAt: null,
    result: null,
    startError: null,
    ...extra,
  }) as unknown as Session;

describe("sortSessionsByAttention", () => {
  it("puts needs-you first, then failed, then the rest in normal order", () => {
    const list = [
      s("idle", "idle", "2026-01-05T00:00:00Z"),
      s("run", "running", "2026-01-01T00:00:00Z"),
      s("fail", "failed", "2026-01-02T00:00:00Z"),
      s("wait-old", "waiting", "2026-01-01T00:00:00Z"),
      s("intr", "interrupted", "2026-01-03T00:00:00Z"),
      s("queued", "queued", "2026-01-09T00:00:00Z"),
    ];
    expect(sortSessionsByAttention(list).map((x) => x.id)).toEqual([
      "intr",
      "wait-old",
      "fail",
      "run",
      "queued",
      "idle",
    ]);
  });
});

describe("sessionOutcome", () => {
  const at = "2026-01-01T00:00:00Z";
  it("is null while a session is not finished", () => {
    expect(sessionOutcome(s("a", "running", at))).toBeNull();
  });
  it("says nothing is needed for a clean success", () => {
    const o = sessionOutcome(
      s("a", "completed", at, { result: { outcome: "success", summary: "Fixed it.", at } }),
    );
    expect(o).toMatchObject({ kind: "done", summary: "Fixed it." });
    expect(o?.action).toMatch(/nothing is needed/);
  });
  it("asks for action on next steps or a blocked result", () => {
    const o = sessionOutcome(
      s("a", "completed", at, {
        result: { outcome: "success", summary: "x", nextSteps: ["Merge the PR"], at },
      }),
    );
    expect(o?.action).toBe("Yes: Merge the PR");
    expect(
      sessionOutcome(s("a", "completed", at, { result: { outcome: "blocked", summary: "x", at } }))
        ?.action,
    ).toMatch(/^Yes/);
  });
  it("gives a failed session a one-line reason", () => {
    const failed = sessionOutcome(
      s("a", "failed", at, {
        result: { outcome: "failed", summary: "Tests broke.\nMore detail", at },
      }),
    );
    expect(failed).toMatchObject({ kind: "failed", reason: "Tests broke." });
    expect(
      sessionOutcome(s("a", "failed", at, { startError: { message: "CLI not signed in" } }))
        ?.reason,
    ).toBe("CLI not signed in");
    expect(sessionOutcome(s("a", "failed", at))?.reason).toMatch(/Something went wrong/);
  });
});
