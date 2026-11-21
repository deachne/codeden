import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryItem, FactoryLoop, OwnerCheckRun, Project } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import type { FactoryContext } from "../src/services/factory/context";
import { targetBranchOf } from "../src/services/factory/context";
import {
  advanceRelease,
  approveRelease,
  readBatchOwner,
  releaseBatchItems,
  releaseInboxId,
  releaseTarget,
} from "../src/services/factory/release";

const NOW = "2026-11-20T12:00:00.000Z";

// A merge commit's short sha, as `merge.ts` stamps it into `merged_on_<sha>_<branch>` nudges.
const SHA = "abc123456789";

const project = {
  id: "p1",
  kind: "github",
  github: { defaultBranch: "main" },
  defaultBranch: "main",
  factoryLimits: { autoMerge: true },
} as unknown as Project;

const loopWith = (tuning: Partial<FactoryLoop["tuning"]>, release?: FactoryLoop["release"]) =>
  ({
    projectId: "p1",
    tuning: { releaseMode: false, releaseBranch: "release", ...tuning },
    release: release ?? {
      branch: "release",
      headSha: null,
      ci: null,
      batch: [],
      releasedSha: null,
      released: [],
      ownerChecks: { state: "skipped", count: 0, failed: [] },
      canRelease: false,
      blockReason: null,
      updatedAt: null,
    },
  }) as unknown as FactoryLoop;

const itemWith = (id: string, patch: Record<string, unknown> = {}): FactoryItem =>
  ({
    id,
    projectId: "p1",
    title: `Work ${id}`,
    stage: "merged",
    pr: { number: 10, url: "https://github.com/o/r/pull/10", state: "merged" },
    mergeSha: SHA,
    mergedAt: NOW,
    updatedAt: NOW,
    nudges: { [`merged_on_${SHA}_release`]: NOW },
    ...patch,
  }) as unknown as FactoryItem;

function stubCtx(
  items: FactoryItem[],
  head: { sha: string; checks: string; failed: string[] } = {
    sha: "abc1234",
    checks: "success",
    failed: [],
  },
  over: {
    store?: Record<string, unknown>;
    github?: Record<string, unknown>;
    sessions?: Record<string, unknown>;
    mainCi?: Record<string, unknown>;
    ctx?: Record<string, unknown>;
  } = {},
) {
  const inbox = new Map<string, { id: string; status: string; [k: string]: unknown }>();
  const created: FactoryItem[] = [];
  const all = () => [...items, ...created];
  const ctx = {
    now: () => new Date(NOW),
    projects: { get: () => project },
    store: {
      items: (_projectId: string, stages?: string[]) =>
        stages ? all().filter((i) => stages.includes(i.stage)) : all(),
      item: (id: string) => all().find((i) => i.id === id),
      createItem: (draft: Record<string, unknown>) => {
        const item = { ...draft, id: `created-${created.length}` } as unknown as FactoryItem;
        created.push(item);
        return item;
      },
      updateItem: (id: string, fn: (i: FactoryItem) => FactoryItem) => {
        const at = all().findIndex((i) => i.id === id);
        const next = fn(all()[at] as FactoryItem);
        if (at < items.length) items[at] = next;
        else created[at - items.length] = next;
        return next;
      },
      saveTick: (loop: FactoryLoop) => loop,
      loopOrNew: (_projectId: string) => loopWith({ releaseMode: true }),
      ...((over.store ?? {}) as Record<string, unknown>),
    },
    inbox: {
      find: (id: string) => inbox.get(id) ?? null,
      put: (item: { id: string }) => {
        inbox.set(item.id, { ...item, status: "open" });
      },
      close: (item: { id: string }, status: string, opts?: Record<string, unknown>) => {
        inbox.set(item.id, { ...inbox.get(item.id), ...item, status, ...opts });
      },
    },
    github: {
      ensureBranch: async () => head.sha,
      branchHead: async () => head,
      commitChecks: async () => "success",
      failedChecks: async () => [],
      mergeBranches: async () => ({ merged: true, sha: "relsha123456789" }),
      ...((over.github ?? {}) as Record<string, unknown>),
    },
    mainCi: {
      head: async () => ({ sha: "mainsha1", checks: "success", failed: [] }),
      ...((over.mainCi ?? {}) as Record<string, unknown>),
    },
    sessions: {
      providers: () => ["fake"],
      unavailable: () => [],
      startRevert: async () => {
        throw new Error("no runner in the stub");
      },
      ...((over.sessions ?? {}) as Record<string, unknown>),
    },
    notify: () => {},
    log: () => {},
    ...over.ctx,
  } as unknown as FactoryContext;
  return { ctx, inbox, created };
}

describe("releaseTarget", () => {
  it("is off and targets the default branch by default", () => {
    expect(releaseTarget(project, loopWith({}))).toEqual({
      on: false,
      target: "main",
      base: "main",
    });
    expect(targetBranchOf(project, loopWith({}).tuning)).toBe("main");
  });

  it("targets the release branch while release mode is on", () => {
    expect(releaseTarget(project, loopWith({ releaseMode: true }))).toEqual({
      on: true,
      target: "release",
      base: "main",
    });
    expect(targetBranchOf(project, loopWith({ releaseMode: true }).tuning)).toBe("release");
  });

  it("reads as off without auto-merge: release mode requires it", () => {
    const off = { ...project, factoryLimits: { autoMerge: false } } as unknown as Project;
    expect(releaseTarget(off, loopWith({ releaseMode: true }))).toEqual({
      on: false,
      target: "main",
      base: "main",
    });
    const unstamped = { ...project, factoryLimits: undefined } as unknown as Project;
    expect(targetBranchOf(unstamped, loopWith({ releaseMode: true }).tuning)).toBe("main");
  });
});

describe("releaseBatchItems", () => {
  it("keeps watching and merged work with a merge commit, minus released work", () => {
    const items = [
      itemWith("a", { stage: "watching" }),
      itemWith("b"),
      itemWith("c", { nudges: { released_abc1234: NOW } }),
      itemWith("d", { mergeSha: null }),
      itemWith("e", { stage: "building" }),
    ];
    const { ctx } = stubCtx(items);
    const tuning = loopWith({ releaseMode: true }).tuning;
    expect(releaseBatchItems(ctx, project, tuning).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("only counts merges that landed on the release branch", () => {
    const items = [
      itemWith("fresh", { stage: "watching" }),
      // Merged straight into the default branch before release mode was turned on.
      itemWith("before", { nudges: { [`merged_on_${SHA}_main`]: NOW } }),
      // Merged into the default branch while release mode was off again.
      itemWith("while-off", { nudges: { [`merged_on_${SHA}_main`]: NOW } }),
      // Merged before merge targets were stamped: not provably on the release branch.
      itemWith("legacy", { mergeSha: SHA, nudges: {} }),
    ];
    const { ctx } = stubCtx(items);
    const tuning = loopWith({ releaseMode: true }).tuning;
    expect(releaseBatchItems(ctx, project, tuning).map((i) => i.id)).toEqual(["fresh"]);
  });
});

describe("advanceRelease", () => {
  it("clears the snapshot and closes the inbox while release mode is off", async () => {
    const open = {
      id: releaseInboxId("p1"),
      status: "open",
      title: "old",
      body: "old",
    };
    const { ctx, inbox } = stubCtx([itemWith("a")]);
    inbox.set(open.id, open);
    const next = await advanceRelease(ctx, project, loopWith({}));
    expect(next.release.batch).toEqual([]);
    expect(next.release.canRelease).toBe(false);
    expect(inbox.get(open.id)?.status).toBe("resolved");
  });

  it("reports an empty batch and resolves the inbox", async () => {
    const open = { id: releaseInboxId("p1"), status: "open", title: "old", body: "old" };
    const { ctx, inbox } = stubCtx([]);
    inbox.set(open.id, open);
    const next = await advanceRelease(ctx, project, loopWith({ releaseMode: true }));
    expect(next.release.branch).toBe("release");
    expect(next.release.headSha).toBe("abc1234");
    expect(next.release.batch).toEqual([]);
    expect(inbox.get(open.id)?.status).toBe("resolved");
  });

  it("blocks the batch while CI on the release branch is red", async () => {
    const { ctx, inbox } = stubCtx([itemWith("a"), itemWith("b")], {
      sha: "def5678",
      checks: "failure",
      failed: ["ci"],
    });
    const next = await advanceRelease(
      ctx,
      project,
      loopWith({ releaseMode: true, ownerChecks: false }),
    );
    expect(next.release.batch.map((b) => b.itemId)).toEqual(["a", "b"]);
    expect(next.release.canRelease).toBe(false);
    expect(next.release.blockReason).toMatch(/red/);
    expect(inbox.get(releaseInboxId("p1"))?.status).toBe("open");
  });

  it("pauses release approval while CI on the default branch is red", async () => {
    const { ctx, inbox } = stubCtx([itemWith("a")], undefined, {
      mainCi: { head: async () => ({ sha: "mainsha1", checks: "failure", failed: ["ci"] }) },
    });
    const next = await advanceRelease(
      ctx,
      project,
      loopWith({ releaseMode: true, ownerChecks: false }),
    );
    expect(next.release.batch.map((b) => b.itemId)).toEqual(["a"]);
    expect(next.release.canRelease).toBe(false);
    expect(next.release.blockReason).toMatch(/CI on main is red/);
    expect(inbox.get(releaseInboxId("p1"))?.status).toBe("open");
  });

  it("reads the batch as releasable when CI is green and owner checks are off", async () => {
    const { ctx } = stubCtx([itemWith("a")]);
    const next = await advanceRelease(
      ctx,
      project,
      loopWith({ releaseMode: true, ownerChecks: false }),
    );
    expect(next.release.canRelease).toBe(true);
    expect(next.release.blockReason).toBeNull();
    expect(next.release.ownerChecks.state).toBe("skipped");
  });

  it("clears a released batch once CI on the default branch is green", async () => {
    const open = { id: releaseInboxId("p1"), status: "open", title: "watching", body: "watching" };
    const { ctx, inbox } = stubCtx([], undefined, {
      github: { commitChecks: async () => "success" },
    });
    inbox.set(open.id, open);
    const loop = loopWith(
      { releaseMode: true, ownerChecks: false },
      {
        branch: "release",
        headSha: "relsha123456789",
        ci: "success",
        batch: [],
        releasedSha: "relsha123456789",
        released: [
          {
            itemId: "a",
            title: "Work a",
            prNumber: 10,
            url: "https://github.com/o/r/pull/10",
            mergedAt: NOW,
          },
        ],
        ownerChecks: { state: "skipped", count: 0, failed: [] },
        canRelease: false,
        blockReason: null,
        updatedAt: NOW,
      },
    );
    const next = await advanceRelease(ctx, project, loop);
    expect(next.release.releasedSha).toBeNull();
    expect(next.release.released).toEqual([]);
    expect(inbox.get(open.id)?.status).toBe("resolved");
    expect(inbox.get(open.id)?.note).toMatch(/green/);
  });

  it("regresses a released batch whose CI on the default branch is red", async () => {
    const items = [itemWith("a", { nudges: { released_abc1234: NOW } })];
    const { ctx, inbox, created } = stubCtx(items, undefined, {
      github: {
        commitChecks: async () => "failure",
        failedChecks: async () => ["ci"],
      },
    });
    const open = { id: releaseInboxId("p1"), status: "open", title: "watching", body: "watching" };
    inbox.set(open.id, open);
    const loop = loopWith(
      { releaseMode: true, ownerChecks: false },
      {
        branch: "release",
        headSha: "relsha123456789",
        ci: "success",
        batch: [],
        releasedSha: "relsha123456789",
        released: [
          {
            itemId: "a",
            title: "Work a",
            prNumber: 10,
            url: "https://github.com/o/r/pull/10",
            mergedAt: NOW,
          },
        ],
        ownerChecks: { state: "skipped", count: 0, failed: [] },
        canRelease: false,
        blockReason: null,
        updatedAt: NOW,
      },
    );
    const next = await advanceRelease(ctx, project, loop);
    expect(next.state).toBe("paused");
    expect(next.pausedReason).toMatch(/^CI on main failed after merging #/);
    expect(next.release.releasedSha).toBeNull();
    const reverted = (ctx.store.item as (id: string) => FactoryItem)("a");
    expect(reverted.stage).toBe("reverted");
    expect(reverted.nudges.after_revert_due).toBe(NOW);
    expect(reverted.nudges["failed_on_main:ci"]).toBe(NOW);
    // The revert targets the default branch, not the release branch.
    expect(created).toHaveLength(1);
    expect(created[0]?.source).toBe("revert");
    expect(created[0]?.revertOf).toBe("a");
    expect(created[0]?.nudges.revert_release_relsha123456789).toBe(NOW);
    expect(created[0]?.note).toMatch(/revert/);
  });
});

describe("approveRelease", () => {
  const releasable = () => stubCtx([itemWith("a")]);

  it("merges the release branch and watches the release on the default branch", async () => {
    const { ctx, inbox } = releasable();
    const snapshot = await approveRelease(ctx, "p1");
    expect(snapshot.releasedSha).toBe("relsha123456789");
    expect(snapshot.released.map((b) => b.itemId)).toEqual(["a"]);
    expect(snapshot.batch).toEqual([]);
    const released = (ctx.store.item as (id: string) => FactoryItem)("a");
    expect(Object.keys(released.nudges).some((k) => k.startsWith("released_"))).toBe(true);
    expect(inbox.get(releaseInboxId("p1"))?.status).toBe("open");
    expect(inbox.get(releaseInboxId("p1"))?.title).toMatch(/watching CI on main/);
  });

  it("refuses while release mode is off", async () => {
    const { ctx } = stubCtx([itemWith("a")], undefined, {
      store: { loopOrNew: () => loopWith({}) },
    });
    await expect(approveRelease(ctx, "p1")).rejects.toMatchObject({ code: "release_mode_off" });
  });

  it("refuses an empty batch", async () => {
    const { ctx } = stubCtx([]);
    await expect(approveRelease(ctx, "p1")).rejects.toMatchObject({ code: "release_not_ready" });
  });

  it("refuses while CI on the release branch is red", async () => {
    const { ctx } = stubCtx([itemWith("a")], { sha: "def5678", checks: "failure", failed: ["ci"] });
    await expect(approveRelease(ctx, "p1")).rejects.toMatchObject({ code: "release_not_ready" });
  });

  it("refuses while CI on the default branch is red", async () => {
    const { ctx } = stubCtx([itemWith("a")], undefined, {
      mainCi: {
        head: async () => ({ sha: "mainsha1", checks: "failure", failed: ["ci"] }),
      },
    });
    await expect(approveRelease(ctx, "p1")).rejects.toMatchObject({ code: "release_not_ready" });
  });
});

describe("readBatchOwner", () => {
  const checks = [{ id: "c1", text: "Export works", updatedAt: "2026-11-20T11:00:00.000Z" }];
  const devProject = (() => {
    const dir = join(tmpdir(), `codeden-release-${Date.now()}`);
    mkdirSync(join(dir, ".codeden"), { recursive: true });
    writeFileSync(
      join(dir, ".codeden", "project.json"),
      JSON.stringify({ devServer: { command: "pnpm dev", port: 5173 } }),
    );
    return { ...project, path: dir };
  })();
  const ownerCtx = (runs: OwnerCheckRun[]) =>
    stubCtx([], undefined, {
      ctx: {
        exec: async () => {
          throw new Error("no git in the stub");
        },
      },
      store: {
        ownerChecks: {
          checks: () => checks,
          latestReleaseRun: () => runs[0],
        },
      },
    }).ctx;

  it("is skipped without the tuning switch", async () => {
    const { ctx } = stubCtx([]);
    const loop = { ...loopWith({}), tuning: { ...loopWith({}).tuning, ownerChecks: false } };
    expect(await readBatchOwner(ctx, project, loop, "abc1234")).toMatchObject({ state: "skipped" });
  });

  it("is not run without a tryout of the head", async () => {
    const ctx = ownerCtx([]);
    const loop = loopWith({ releaseMode: true, ownerChecks: true });
    (ctx.projects.get as () => Project) = () => devProject;
    expect(await readBatchOwner(ctx, devProject, loop, "abc1234")).toMatchObject({
      state: "not_run",
      count: 1,
    });
  });

  it("follows a running tryout, and forgets one that ended in error", async () => {
    const running: OwnerCheckRun = {
      id: "r1",
      projectId: "p1",
      source: "release",
      itemId: null,
      prNumber: null,
      headSha: "abc1234",
      forSessionId: null,
      sessionId: "s1",
      checkIds: ["c1"],
      state: "running",
      results: [],
      detail: null,
      nudgedAt: null,
      startedAt: "2026-11-20T11:30:00.000Z",
      endedAt: null,
    };
    const errored = { ...running, id: "r2", state: "error" as const };
    const loop = loopWith({ releaseMode: true, ownerChecks: true });
    expect(await readBatchOwner(ownerCtx([running]), devProject, loop, "abc1234")).toMatchObject({
      state: "running",
    });
    expect(await readBatchOwner(ownerCtx([errored]), devProject, loop, "abc1234")).toMatchObject({
      state: "not_run",
    });
  });
});
