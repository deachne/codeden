import type { FactoryItem } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

let env: FactoryEnv;
afterEach(() => env?.close());

const tick = () => env.factory.tick(env.project.id);
const item = (id: string) => env.factory.data.item(id) as FactoryItem;

/** A builder PR that fails merge checks with no revise round left, then the loop's view of it. */
async function failedPr(pr: { files: string[]; checks: "success" | "failure"; evidence: boolean }) {
  // One evidence slip stays below a run of 2; one CI failure still pauses at 1.
  env = createFactoryEnv({ limits: { pauseAfterConsecutiveFailures: pr.evidence ? 1 : 2 } });
  env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: { ...env.project.factoryLimits, autoMerge: true },
    tuning: { maxFixAttempts: 0 },
  } as Parameters<FactoryEnv["factory"]["setMode"]>[1]);
  const created = env.factory.data.createItem({
    projectId: env.project.id,
    workKey: "issue:7",
    title: "Add a counter",
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
  env.gh.openPr({ sessionId, title: created.title, testOutput: true, ...pr });
  await env.setStatus(sessionId, "idle");
  await tick();
  await tick();
  return created.id;
}

describe("failed merge checks and the pause streak", () => {
  it("missing screenshots fail the item but don't count towards pausing", async () => {
    const id = await failedPr({
      files: ["apps/web/src/components/board.tsx", "apps/web/test/board.test.ts"],
      checks: "success",
      evidence: false,
    });
    expect(item(id).stage).toBe("failed");
    expect(item(id).reason).toMatch(/no screenshots were attached/);
    expect(item(id).reason).toMatch(/re-attach/);
    const loop = env.factory.data.loopOrNew(env.project.id);
    expect(loop.consecutiveFailures).toBe(0);
    expect(loop.state).not.toBe("paused");
  });

  it("a CI failure still counts", async () => {
    const id = await failedPr({
      files: ["src/a.ts", "test/a.test.ts"],
      checks: "failure",
      evidence: true,
    });
    expect(item(id).stage).toBe("failed");
    expect(env.factory.data.loopOrNew(env.project.id).state).toBe("paused");
  });
});
