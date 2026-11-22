import type { Session, SessionStatus } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  projectAllQuiet,
  roleSessionFor,
  sessionStatusLabel,
  sessionTone,
} from "../src/lib/format";

describe("sessionTone", () => {
  it("shows an idle session that finished its last turn as done", () => {
    expect(sessionTone("idle", "completed")).toBe("done");
    expect(sessionStatusLabel("idle", "completed")).toBe("Done");
  });

  it("keeps grey for idle sessions that never ran or were interrupted", () => {
    for (const last of [undefined, null, "interrupted"] as const) {
      expect(sessionTone("idle", last)).toBe("idle");
      expect(sessionStatusLabel("idle", last)).toBe("Idle");
    }
  });

  it("shows an idle session whose last turn failed as failed", () => {
    expect(sessionTone("idle", "failed")).toBe("failed");
    expect(sessionStatusLabel("idle", "failed")).toBe("Failed");
  });

  it("leaves every other status alone, whatever the last turn was", () => {
    expect(sessionTone("created", "completed")).toBe("idle");
    expect(sessionTone("queued", "completed")).toBe("idle");
    expect(sessionTone("stopped", "completed")).toBe("idle");
    for (const last of [undefined, "completed", "failed"] as const) {
      expect(sessionTone("interrupted", last)).toBe("idle");
    }
    expect(sessionTone("running", "completed")).toBe("running");
    expect(sessionTone("waiting", "completed")).toBe("waiting");
    expect(sessionTone("failed", "completed")).toBe("failed");
    expect(sessionTone("completed", "failed")).toBe("done");
  });
});

describe("projectAllQuiet", () => {
  const s = (status: SessionStatus, lastTurnStatus?: "completed" | "failed" | "interrupted") => ({
    status,
    lastTurnStatus,
  });

  it("is false with no agents", () => {
    expect(projectAllQuiet([])).toBe(false);
  });

  it("is true when agents are only done, idle, never ran or stopped", () => {
    expect(projectAllQuiet([s("idle", "completed"), s("idle"), s("stopped"), s("completed")])).toBe(
      true,
    );
  });

  it("is false while any agent is working, needs you or failed", () => {
    for (const bad of [
      s("running"),
      s("starting"),
      s("waiting"),
      s("failed"),
      s("idle", "failed"),
    ]) {
      expect(projectAllQuiet([s("idle", "completed"), bad])).toBe(false);
    }
  });
});

describe("seat kind x state", () => {
  // Every seat kind (orchestrator, PM, builder, helper) shares one rule.
  const cases: [string, SessionStatus, "completed" | "failed" | undefined, string][] = [
    ["working", "running", undefined, "running"],
    ["starting", "starting", undefined, "running"],
    ["needs you", "waiting", undefined, "waiting"],
    ["finished", "idle", "completed", "done"],
    ["completed", "completed", undefined, "done"],
    ["failed turn", "idle", "failed", "failed"],
    ["failed", "failed", undefined, "failed"],
    ["never ran", "idle", undefined, "idle"],
    ["stopped", "stopped", undefined, "idle"],
    ["interrupted", "interrupted", undefined, "idle"],
  ];
  for (const seat of ["orchestrator", "pm", "builder", "helper"]) {
    for (const [name, status, last, tone] of cases) {
      it(`${seat}: ${name} is ${tone}`, () => {
        expect(sessionTone(status, last)).toBe(tone);
      });
    }
  }

  it("ignores a PM (not passed in) but a failed or working helper breaks All quiet", () => {
    const quiet = { status: "idle", lastTurnStatus: "completed" } as const;
    expect(projectAllQuiet([quiet])).toBe(true);
    expect(projectAllQuiet([quiet, { status: "running" }])).toBe(false);
    expect(projectAllQuiet([quiet, { status: "idle", lastTurnStatus: "failed" }])).toBe(false);
  });
});

describe("roleSessionFor", () => {
  const mk = (
    id: string,
    createdAt: string,
    archivedAt: string | null = null,
    role = "orchestrator",
  ) =>
    ({
      id,
      role,
      projectId: role === "pm" ? "p1" : null,
      createdAt,
      archivedAt,
    }) as unknown as Session;

  it("shows the live orchestrator, not an older archived one (stuck-dot regression)", () => {
    const list = [
      mk("old", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
      mk("new", "2026-02-01T00:00:00Z"),
    ];
    expect(roleSessionFor(list, "orchestrator", null)?.id).toBe("new");
    expect(roleSessionFor(list, "orchestrator", null, "new")?.id).toBe("new");
  });

  it("ignores an archived ref and other projects' PMs", () => {
    const list = [
      mk("a", "2026-01-01T00:00:00Z", "x", "pm"),
      mk("b", "2026-01-02T00:00:00Z", null, "pm"),
    ];
    expect(roleSessionFor(list, "pm", "p1", "a")?.id).toBe("b");
    expect(roleSessionFor(list, "pm", "p2")).toBeUndefined();
  });
});
