import type { AutomationRun } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  AutomationExecutor,
  type ExecutorDeps,
  TRIAGE_TIMEOUT_MS,
} from "../src/services/automations/executor";

const NOW = new Date("2026-05-01T12:00:00.000Z");

function run(id: string, automationId: string, ageMs: number): AutomationRun {
  return {
    id,
    automationId,
    projectId: "p",
    status: "running",
    startedAt: new Date(NOW.getTime() - ageMs).toISOString(),
  } as AutomationRun;
}

describe("expireAllStaleTriage (#121)", () => {
  it("fails old running triage runs without anyone firing the automation again", () => {
    const rows = [
      run("old-triage", "triage", TRIAGE_TIMEOUT_MS + 1),
      run("fresh-triage", "triage", 1000),
      run("old-other", "other", TRIAGE_TIMEOUT_MS + 1),
      run("old-gone", "gone", TRIAGE_TIMEOUT_MS + 1),
    ];
    const executor = new AutomationExecutor({
      now: () => NOW,
      runs: {
        allRunningBefore: (before: string) => rows.filter((r) => r.startedAt < before),
        save: (r: AutomationRun) => {
          rows.splice(
            rows.findIndex((x) => x.id === r.id),
            1,
            r,
          );
          return r;
        },
      },
    } as unknown as ExecutorDeps);
    executor.expireAllStaleTriage(NOW, (r) => r.automationId !== "other");
    const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(status).toEqual({
      "old-triage": "failed",
      "fresh-triage": "running",
      "old-other": "running",
      "old-gone": "failed",
    });
  });
});
