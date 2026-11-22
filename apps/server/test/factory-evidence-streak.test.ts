import type { FactoryItem } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

let env: FactoryEnv;
afterEach(() => env?.close());

const tick = () => env.factory.tick(env.project.id);
const item = (id: string) => env.factory.data.item(id) as FactoryItem;

/** One more work item whose builder PR has UI files but no screenshots. */
async function evidenceFailure(
  n: number,
  pr: { checks: "success" | "failure"; evidence: boolean } = { checks: "success", evidence: false },
) {
  const created = env.factory.data.createItem({
    projectId: env.project.id,
    workKey: `issue:${n}`,
    title: `Add counter ${n}`,
    summary: "Users want to count things",
    source: "discovery",
    stage: "backlog",
    type: "feature",
    investigation: {
      kind: "analysis",
      outcome: "implement",
      summary: "Missing",
      details: "A counter",
      testPath: null,
    },
  } as Parameters<FactoryEnv["factory"]["data"]["createItem"]>[0]);
  await tick();
  const sessionId = item(created.id).builderSessionId as string;
  env.gh.openPr({
    sessionId,
    title: created.title,
    files: ["apps/web/src/components/board.tsx", "apps/web/test/board.test.ts"],
    ...pr,
    testOutput: true,
  });
  await env.setStatus(sessionId, "idle");
  await tick();
  await tick();
  return created.id;
}

describe("a run of evidence-only failures", () => {
  it("pauses the loop with a plain reason once the run reaches the limit", async () => {
    env = createFactoryEnv({ limits: { pauseAfterConsecutiveFailures: 2 } });
    env.factory.setMode(env.project.id, {
      mode: "software_factory",
      limits: { ...env.project.factoryLimits, autoMerge: true },
      tuning: { maxFixAttempts: 0 },
    } as Parameters<FactoryEnv["factory"]["setMode"]>[1]);
    const first = await evidenceFailure(1);
    expect(item(first).stage).toBe("failed");
    expect(env.factory.data.loopOrNew(env.project.id).state).not.toBe("paused");
    await evidenceFailure(2);
    const loop = env.factory.data.loopOrNew(env.project.id);
    // The code-quality streak stays untouched; the evidence run is what pauses.
    expect(loop.consecutiveFailures).toBe(0);
    expect(loop.state).toBe("paused");
    expect(loop.pausedReason).toMatch(/screenshots or test output/);
    expect(env.inbox.find(`inbox:factory-paused:${env.project.id}`)).toBeTruthy();
  });

  it("a code failure in between resets the run", async () => {
    env = createFactoryEnv({ limits: { pauseAfterConsecutiveFailures: 2 } });
    env.factory.setMode(env.project.id, {
      mode: "software_factory",
      limits: { ...env.project.factoryLimits, autoMerge: true },
      tuning: { maxFixAttempts: 0 },
    } as Parameters<FactoryEnv["factory"]["setMode"]>[1]);
    await evidenceFailure(1);
    expect(env.factory.data.loopOrNew(env.project.id).evidenceFailures).toBe(1);
    await evidenceFailure(2, { checks: "failure", evidence: true });
    const loop = env.factory.data.loopOrNew(env.project.id);
    expect(loop.evidenceFailures).toBe(0);
    expect(loop.consecutiveFailures).toBe(1);
  });
});
