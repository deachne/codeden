import { describe, expect, it } from "vitest";
import { sessionStatusLabel, sessionTone } from "../src/lib/format";

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
