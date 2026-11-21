import type { FactoryItem, FactoryLoop, FactoryReleaseSnapshot, Project } from "@codeden/contracts";
import { conflict, errorMessage, ServiceError } from "../errors";
import { type FactoryContext, factoryNotice, raiseInbox, targetBranchOf } from "./context";
import { coversNow, failedForBuilder, projectDevServer } from "./owner-checks";
import { startTryout } from "./owner-checks-run";
import { claimSlot } from "./slots";

/**
 * Release mode (§10.1, #4): approved work merges into a release branch, and one approval
 * releases the whole batch into the default branch. The per-PR pipeline (review, CI, the merge
 * queue) runs against the release branch unchanged; this step owns the batch on top of it.
 */

/** Nudge prefix marking an item released into the default branch (`released_<head sha>`). */
export const RELEASED = "released_";

/** Inbox id of the batch waiting for its release (one per project). */
export const releaseInboxId = (projectId: string) => `inbox:factory-release:${projectId}`;

/** Whether the item went out with a release already. */
function isReleased(item: Pick<FactoryItem, "nudges">): boolean {
  return Object.keys(item.nudges).some((k) => k.startsWith(RELEASED));
}

/** Merged work not yet released: the batch. Reverts merged into the release branch count too. */
export function releaseBatchItems(ctx: FactoryContext, projectId: string): FactoryItem[] {
  return ctx.store
    .items(projectId, ["watching", "merged"])
    .filter((i) => i.mergeSha && !isReleased(i));
}

/** The branch the factory merges into and watches, and the default branch it releases into. */
export function releaseTarget(
  project: Project,
  loop: FactoryLoop,
): { on: boolean; target: string; base: string } {
  const target = targetBranchOf(project, loop.tuning);
  const base =
    project.kind === "github" ? project.github.defaultBranch : (project.defaultBranch ?? "main");
  return { on: target !== base, target, base };
}

const EMPTY_SNAPSHOT: FactoryReleaseSnapshot = {
  branch: "release",
  headSha: null,
  ci: null,
  batch: [],
  ownerChecks: { state: "skipped", count: 0, failed: [] },
  canRelease: false,
  blockReason: null,
  updatedAt: null,
};

/** Refresh the release snapshot and inbox on one tick. */
export async function advanceRelease(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<FactoryLoop> {
  const { on, target, base } = releaseTarget(project, loop);
  const now = ctx.now().toISOString();
  if (!on) {
    const open = ctx.inbox.find(releaseInboxId(project.id));
    if (open?.status === "open") ctx.inbox.close(open, "resolved", { note: "release mode is off" });
    if (loop.release.batch.length > 0 || loop.release.canRelease) {
      return {
        ...loop,
        release: { ...EMPTY_SNAPSHOT, branch: loop.release.branch, updatedAt: now },
      };
    }
    return loop;
  }
  let head: { sha: string; checks: string; failed: string[] };
  try {
    await ctx.github.ensureBranch(project.id, target);
    head = await ctx.github.branchHead(project.id, target);
  } catch (error) {
    const snapshot: FactoryReleaseSnapshot = {
      ...EMPTY_SNAPSHOT,
      branch: target,
      blockReason: `Could not read the release branch: ${errorMessage(error)}`,
      updatedAt: now,
    };
    return { ...loop, release: snapshot };
  }
  const batch = releaseBatchItems(ctx, project.id);
  if (batch.length === 0) {
    const open = ctx.inbox.find(releaseInboxId(project.id));
    if (open?.status === "open") ctx.inbox.close(open, "resolved", { note: "released" });
    return {
      ...loop,
      release: { ...EMPTY_SNAPSHOT, branch: target, headSha: head.sha, updatedAt: now },
    };
  }
  const batchList = batch.map((i) => ({
    itemId: i.id,
    title: i.title,
    prNumber: i.pr?.number ?? 0,
    url: i.pr?.url ?? "",
    mergedAt: i.mergedAt ?? i.updatedAt,
  }));
  const ci = head.checks as FactoryReleaseSnapshot["ci"];
  if (ci !== "success") {
    const snapshot: FactoryReleaseSnapshot = {
      ...EMPTY_SNAPSHOT,
      branch: target,
      headSha: head.sha,
      ci,
      batch: batchList,
      blockReason:
        ci === "failure"
          ? `CI on ${target} is red (${head.failed.slice(0, 5).join(", ") || "failing checks"}): the batch can't be released until it is green again`
          : `Waiting for CI on ${target} (${head.sha.slice(0, 7)})`,
      updatedAt: now,
    };
    settleReleaseInbox(ctx, project, base, snapshot, batch);
    return { ...loop, release: snapshot };
  }
  // CI is green on the release head: the batch's owner checks decide.
  const owner = await readBatchOwner(ctx, project, loop, head.sha);
  if (owner.state === "not_run") startBatchTryout(ctx, project, target, head.sha);
  const blockReason =
    owner.state === "pass" || owner.state === "skipped"
      ? null
      : owner.state === "running" || owner.state === "not_run"
        ? `Owner checks are ${owner.state === "running" ? "running" : "starting"} on ${target}`
        : `Owner check${owner.failed.length === 1 ? "" : "s"} ${owner.failed.join(", ")} failed on the release branch: fix them and they run again`;
  const snapshot: FactoryReleaseSnapshot = {
    branch: target,
    headSha: head.sha,
    ci,
    batch: batchList,
    ownerChecks: { state: owner.state, count: owner.count, failed: owner.failed },
    canRelease: owner.state === "pass" || owner.state === "skipped",
    blockReason,
    updatedAt: now,
  };
  settleReleaseInbox(ctx, project, base, snapshot, batch);
  return { ...loop, release: snapshot };
}

interface BatchOwner {
  state: "skipped" | "not_run" | "running" | "pass" | "fail";
  count: number;
  failed: number[];
  why?: string;
}

/**
 * Where the batch's owner checks stand on the release head: a `source: "release"` tryout run of
 * exactly that head and the checks in force. One tryout covers the whole batch, not one per PR.
 */
export async function readBatchOwner(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  headSha: string,
): Promise<BatchOwner> {
  if (!loop.tuning.ownerChecks)
    return { state: "skipped", count: 0, failed: [], why: "switched off" };
  const checks = ctx.store.ownerChecks.checks(project.id);
  if (checks.length === 0)
    return { state: "skipped", count: 0, failed: [], why: "the project has no owner checks" };
  const dev = await projectDevServer(project, { exec: ctx.exec, head: headSha });
  if (!dev) {
    return {
      state: "skipped",
      count: 0,
      failed: [],
      why: "no devServer in .codeden/project.json, so the app can't be started to try them",
    };
  }
  const count = checks.length;
  const last = ctx.store.ownerChecks.latestReleaseRun(project.id);
  if (!last || last.headSha !== headSha || !coversNow(last, checks)) {
    return { state: "not_run", count, failed: [] };
  }
  if (last.state === "running") return { state: "running", count, failed: [] };
  if (last.state === "passed") return { state: "pass", count, failed: [] };
  if (last.state === "failed") {
    return { state: "fail", count, failed: failedForBuilder(last, checks).map((f) => f.number) };
  }
  return { state: "not_run", count, failed: [] };
}

/** Start the batch's tryout run on the release head (the tick's step, never the approve path). */
async function startBatchTryout(
  ctx: FactoryContext,
  project: Project,
  target: string,
  headSha: string,
): Promise<void> {
  if (!claimSlot(ctx, project, "review", `tryout:release:${project.id}`)) return;
  try {
    await startTryout(ctx, project, {
      source: "release",
      item: null,
      prNumber: null,
      headSha,
      forSessionId: null,
      branch: target,
      fetch: true,
      label: `the release branch \`${target}\``,
    });
  } catch (error) {
    ctx.log?.(`factory: release tryout: ${errorMessage(error)}`);
  }
}

/** The release inbox follows the batch: ready (needs you), waiting, or resolved. */
function settleReleaseInbox(
  ctx: FactoryContext,
  project: Project,
  base: string,
  snapshot: FactoryReleaseSnapshot,
  batch: FactoryItem[],
): void {
  const lines = batch.map(
    (i) => `- ${i.title} (#${i.pr?.number ?? "?"})${i.pr?.url ? ` ${i.pr.url}` : ""}`,
  );
  if (snapshot.canRelease) {
    raiseInbox(ctx, {
      id: releaseInboxId(project.id),
      kind: "pr_review",
      notify: "needs_you",
      priority: "normal",
      projectId: project.id,
      title: `Release batch ready: ${batch.length} change${batch.length === 1 ? "" : "s"} tried on ${snapshot.branch}`,
      body: [
        `Every change below merged into \`${snapshot.branch}\`, CI is green on it${snapshot.ownerChecks.state === "pass" ? ` and the owner checks passed (${snapshot.ownerChecks.count})` : ""}. Approve once to release the whole batch into \`${base}\`.`,
        "",
        ...lines,
      ].join("\n"),
    });
    factoryNotice(ctx, {
      id: `factory.release-ready:${project.id}`,
      projectId: project.id,
      target: "pm",
      event: "ready",
      title: `Release batch ready (${batch.length} into ${snapshot.branch})`,
      text: `CI is green on ${snapshot.branch}; the batch waits for a person's release.`,
      itemIds: batch.map((i) => i.id),
      wake: false,
    });
    return;
  }
  raiseInbox(ctx, {
    id: releaseInboxId(project.id),
    kind: "pr_review",
    notify: "factory",
    priority: "low",
    projectId: project.id,
    title: `Release batch: ${batch.length} change${batch.length === 1 ? "" : "s"} on ${snapshot.branch}`,
    body: [`${snapshot.blockReason ?? "Not ready yet."}`, "", ...lines].join("\n"),
  });
}

/**
 * Approve the batch (`POST .../factory/release/approve`): merge the release branch into the
 * default branch. Only when the gates pass; a conflict leaves the batch for a person to merge.
 */
export async function approveRelease(
  ctx: FactoryContext,
  projectId: string,
): Promise<FactoryReleaseSnapshot> {
  const project = ctx.projects.get(projectId);
  const loop = ctx.store.loopOrNew(projectId, ctx.now());
  const { on, target, base } = releaseTarget(project, loop);
  if (!on) throw conflict("Release mode is off for this project", "release_mode_off");
  const now = ctx.now().toISOString();
  let head: { sha: string; checks: string; failed: string[] };
  try {
    await ctx.github.ensureBranch(projectId, target);
    head = await ctx.github.branchHead(projectId, target);
  } catch (error) {
    throw conflict(
      `Could not read the release branch: ${errorMessage(error)}`,
      "release_not_ready",
    );
  }
  const headSha = head.sha;
  const batch = releaseBatchItems(ctx, projectId);
  if (batch.length === 0) throw conflict("There is nothing to release", "release_not_ready");
  if (head.checks !== "success") {
    throw conflict("CI on the release branch is not green", "release_not_ready");
  }
  const owner = await readBatchOwner(ctx, project, loop, headSha);
  if (owner.state !== "pass" && owner.state !== "skipped") {
    throw conflict("The batch's owner checks haven't passed", "release_not_ready");
  }
  let sha: string | null;
  try {
    ({ sha } = await ctx.github.mergeBranches(projectId, { base, head: target }));
  } catch (error) {
    if (error instanceof ServiceError && error.code === "github_conflict") {
      throw conflict(
        `The release branch conflicts with ${base}: merge it by hand on GitHub, then approve again`,
        "release_conflict",
      );
    }
    throw error;
  }
  const at = ctx.now().toISOString();
  for (const item of batch) {
    ctx.store.updateItem(item.id, (i) => {
      const nudges = Object.fromEntries(
        Object.entries(i.nudges).filter(([k]) => !k.startsWith(RELEASED)),
      );
      return { ...i, nudges: { ...nudges, [`${RELEASED}${headSha.slice(0, 12)}`]: at } };
    });
  }
  const open = ctx.inbox.find(releaseInboxId(projectId));
  if (open?.status === "open") ctx.inbox.close(open, "resolved", { note: "released" });
  const snapshot: FactoryReleaseSnapshot = {
    ...EMPTY_SNAPSHOT,
    branch: target,
    headSha: sha ?? headSha,
    ci: "success",
    updatedAt: now,
  };
  ctx.store.saveTick({ ...loop, release: snapshot }, now);
  return snapshot;
}
