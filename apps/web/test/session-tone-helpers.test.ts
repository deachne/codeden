import { describe, expect, it } from "vitest";
import { projectAllQuiet, sessionStatusLabel, sessionTone } from "../src/lib/format";

// #89: helper sessions (factory reviews, scout, area reviewers) are stopped once their job is
// over, so they sit at "stopped" with a finished last turn. They must show the green check
// like a builder does.
describe("finished helper sessions (stopped after a finished turn)", () => {
  it("shows a stopped session whose last turn finished as done", () => {
    expect(sessionTone("stopped", "completed", "agent")).toBe("done");
    expect(sessionStatusLabel("stopped", "completed", "agent")).toBe("Done");
  });

  it("shows a stopped session whose last turn failed as failed", () => {
    expect(sessionTone("stopped", "failed", "agent")).toBe("failed");
  });

  it("keeps grey for stopped sessions that never ran or were interrupted", () => {
    for (const last of [undefined, null, "interrupted"] as const) {
      expect(sessionTone("stopped", last, "agent")).toBe("idle");
    }
  });

  it("leaves project managers and orchestrators as they were", () => {
    for (const role of ["pm", "orchestrator"] as const) {
      expect(sessionTone("stopped", "completed", role)).toBe("idle");
      expect(sessionTone("stopped", "failed", role)).toBe("idle");
      expect(sessionTone("idle", "completed", role)).toBe("done");
    }
  });

  it("keeps the all-quiet check quiet", () => {
    expect(projectAllQuiet([{ status: "stopped", lastTurnStatus: "completed" }])).toBe(true);
  });
});
