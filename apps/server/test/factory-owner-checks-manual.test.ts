import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_CHECKS_WORK_KEY_PREFIX } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

// Issue #17: owner checks started by hand on a session ("Run owner checks") get the same
// follow-up as the factory's: the tryout is nudged once when it ends without results, the run is
// closed, and the tryout session (and its worktree) is archived once it is idle and done.

let env: FactoryEnv;
afterEach(() => env?.close());
const { tick, later, enable } = factorySteps(() => env);

function setUp() {
  env = createFactoryEnv();
  writeFileSync(
    join(env.project.path, ".codeden", "project.json"),
    JSON.stringify({ devServer: { command: "pnpm dev", port: 5173 } }),
  );
  env.factory.addOwnerCheck(env.project.id, "I can export the summary as a PDF");
}

/** A person's own session with a branch, then "Run owner checks" on it. */
async function manualRun() {
  const own = await env.sessions.start({
    projectId: env.project.id,
    startedBy: { kind: "user" },
    input: { text: "build it" },
  } as Parameters<FactoryEnv["sessions"]["start"]>[0]);
  const sessionId = (own as { sessionId: string }).sessionId;
  await env.setStatus(sessionId, "idle");
  const run = await env.factory.runOwnerChecks(env.project.id, { sessionId });
  expect(run.state).toBe("running");
  const tryout = env.repo
    .list()
    .find((s) => (s.workKey ?? "").startsWith(OWNER_CHECKS_WORK_KEY_PREFIX)) as { id: string };
  return { run, tryout };
}

const runNow = (id: string) =>
  env.factory.ownerChecks(env.project.id).runs.find((r) => r.id === id);

describe("owner checks started by hand (issue #17)", () => {
  it("nudge a tryout that ends without results once, then close the run and archive the tryout", async () => {
    setUp();
    const { run, tryout } = await manualRun();
    await env.setStatus(tryout.id, "idle");
    await tick();
    expect(env.messages.filter((m) => m.sessionId === tryout.id)).toHaveLength(1);
    await env.setStatus(tryout.id, "idle");
    later(2 * 60_000);
    await tick();
    expect(runNow(run.id)?.state).toBe("error");
    expect(runNow(run.id)?.endedAt).not.toBeNull();
    await env.factory.archiver.idle();
    expect(env.archived).toContain(tryout.id);
  });

  it("archive the tryout once it recorded its results and is idle", async () => {
    setUp();
    const { run, tryout } = await manualRun();
    env.factory.submitOwnerChecks(env.repo.get(tryout.id), {
      results: [{ number: 1, state: "pass", observation: "A PDF downloaded." }],
    });
    expect(runNow(run.id)?.state).toBe("passed");
    await env.setStatus(tryout.id, "idle");
    await tick();
    await env.factory.archiver.idle();
    expect(env.archived).toContain(tryout.id);
    expect(env.repo.get(tryout.id).worktreeRemovedAt).not.toBeNull();
  });

  it("are followed up also while the factory runs, for a session no work item owns", async () => {
    setUp();
    enable("software_factory");
    const { run, tryout } = await manualRun();
    await env.setStatus(tryout.id, "idle");
    await tick();
    expect(env.messages.filter((m) => m.sessionId === tryout.id)).toHaveLength(1);
    await env.setStatus(tryout.id, "idle");
    later(2 * 60_000);
    await tick();
    await env.factory.archiver.idle();
    expect(runNow(run.id)?.state).toBe("error");
    expect(env.archived).toContain(tryout.id);
  });

  it("returns only manual runs that still need something (running or unarchived tryout) (issue #23)", async () => {
    setUp();
    const { run, tryout } = await manualRun();
    // 1. While running: returned
    expect(env.factory.ctx.store.ownerChecks.followUpRuns(env.project.id).map((r) => r.id)).toEqual(
      [run.id],
    );

    // 2. Ended (passed) but tryout not archived yet: returned
    env.factory.submitOwnerChecks(env.repo.get(tryout.id), {
      results: [{ number: 1, state: "pass", observation: "A PDF downloaded." }],
    });
    expect(env.factory.ctx.store.ownerChecks.followUpRuns(env.project.id).map((r) => r.id)).toEqual(
      [run.id],
    );

    // 3. Tryout archived: NOT returned
    await env.setStatus(tryout.id, "idle");
    await tick();
    await env.factory.archiver.idle();
    expect(env.archived).toContain(tryout.id);
    expect(env.factory.ctx.store.ownerChecks.followUpRuns(env.project.id)).toEqual([]);
  });

  it("does no owner-check session lookups on a tick when all runs are finished and archived (issue #23)", async () => {
    setUp();
    const { tryout } = await manualRun();
    env.factory.submitOwnerChecks(env.repo.get(tryout.id), {
      results: [{ number: 1, state: "pass", observation: "A PDF downloaded." }],
    });
    await env.setStatus(tryout.id, "idle");
    await tick();
    await env.factory.archiver.idle();
    expect(env.archived).toContain(tryout.id);

    // With all manual runs finished and archived, a tick does no session lookups or archive calls
    const findSpy = vi.spyOn(env.repo, "find");
    const archiveSpy = vi.spyOn(env.factory.ctx, "archiveSessions");
    await tick();
    expect(findSpy).not.toHaveBeenCalled();
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it("does no database writes on a tick for non-factory projects with no runs needing work (issue #23)", async () => {
    setUp();
    expect(env.factory.data.loop(env.project.id)).toBeUndefined();
    const appendSpy = vi.spyOn(env.store, "append");
    await tick();
    expect(env.factory.data.loop(env.project.id)).toBeUndefined();
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("tickAll skips non-factory projects with no runs needing work (issue #23)", async () => {
    setUp();
    const tickSpy = vi.spyOn(env.factory, "tick");
    await env.factory.tickAll();
    expect(tickSpy).not.toHaveBeenCalled();
  });

  it("follows up a release-batch tryout that ends without results, then archives it (#4)", async () => {
    setUp();
    const own = await env.sessions.start({
      projectId: env.project.id,
      startedBy: { kind: "user" },
      input: { text: "build it" },
    } as Parameters<FactoryEnv["sessions"]["start"]>[0]);
    const tryoutId = (own as { sessionId: string }).sessionId;
    await env.setStatus(tryoutId, "idle");
    // A release run names no item, PR or session: `latestForItem` never sees it.
    const checkIds = env.factory.ownerChecks(env.project.id).checks.map((c) => c.id);
    const release = env.factory.ctx.store.ownerChecks.saveRun({
      id: "release-run-1",
      projectId: env.project.id,
      source: "release",
      itemId: null,
      prNumber: null,
      headSha: "abc1234",
      forSessionId: null,
      sessionId: tryoutId,
      checkIds,
      state: "running",
      results: [],
      detail: null,
      nudgedAt: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    });
    expect(env.factory.ctx.store.ownerChecks.followUpRuns(env.project.id).map((r) => r.id)).toEqual(
      [release.id],
    );
    await tick();
    expect(env.messages.filter((m) => m.sessionId === tryoutId)).toHaveLength(1);
    await env.setStatus(tryoutId, "idle");
    later(2 * 60_000);
    await tick();
    expect(runNow(release.id)?.state).toBe("error");
    expect(runNow(release.id)?.endedAt).not.toBeNull();
    await env.factory.archiver.idle();
    expect(env.archived).toContain(tryoutId);
  });
});
