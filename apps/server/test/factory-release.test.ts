import type { FactoryItem, FactoryLoop, Project } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import type { FactoryContext } from "../src/services/factory/context";
import { targetBranchOf } from "../src/services/factory/context";
import {
  advanceRelease,
  releaseBatchItems,
  releaseInboxId,
  releaseTarget,
} from "../src/services/factory/release";

const NOW = "2026-11-20T12:00:00.000Z";

const project = {
  id: "p1",
  kind: "github",
  github: { defaultBranch: "main" },
  defaultBranch: "main",
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
    mergeSha: `sha-${id}`,
    mergedAt: NOW,
    updatedAt: NOW,
    nudges: {},
    ...patch,
  }) as unknown as FactoryItem;

function stubCtx(
  items: FactoryItem[],
  head: { sha: string; checks: string; failed: string[] } = {
    sha: "abc1234",
    checks: "success",
    failed: [],
  },
) {
  const inbox = new Map<string, { id: string; status: string; [k: string]: unknown }>();
  const ctx = {
    now: () => new Date(NOW),
    store: {
      items: (_projectId: string, stages?: string[]) =>
        stages ? items.filter((i) => stages.includes(i.stage)) : items,
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
    },
    notify: () => {},
    log: () => {},
  } as unknown as FactoryContext;
  return { ctx, inbox };
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
    expect(releaseBatchItems(ctx, "p1").map((i) => i.id)).toEqual(["a", "b"]);
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
});
