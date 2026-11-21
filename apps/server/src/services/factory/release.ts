import type {
  FactoryItem,
  FactoryLoop,
  FactoryReleaseBatchItem,
  FactoryReleaseSnapshot,
  Project,
} from "@codeden/contracts";
import { conflict, errorMessage, ServiceError } from "../errors";
import {
  type FactoryContext,
  factoryNotice,
  isReleased,
  mergedOnBranch,
  pauseLoop,
  RELEASED,
  REVERT_RELEASE,
  raiseInbox,
  targetBranchOf,
} from "./context";
import { coversNow, failedForBuilder, projectDevServerAtHead } from "./owner-checks";
import { startTryout } from "./owner-checks-run";
import { recordMainFailure } from "./revert";
import { regressionInboxId, regressionPausePrefix } from "./revert-blocked";
import { revertAgent, revertStartFailed, startRevertAgent } from "./revert-start";
import { claimSlot } from "./slots";
import { REVERTED_AT } from "./stats";

/**
 * Release mode (§10.1, #4): approved work merges into a release branch, and one approval
 * releases the whole batch into the default branch. The per-PR pipeline (review, CI, the merge
 * queue) runs against the release branch unchanged; this step owns the batch on top of it. The
 * batch only counts merges that landed on the release branch, and the release merge itself is
 * watched on the default branch afterwards, with the existing auto-revert on regression.
 */

/** Inbox id of the batch waiting for its release (one per project). */
export const releaseInboxId = (projectId: string) => `inbox:factory-release:${projectId}`;

/**
 * Merged work not yet released: the batch. Only merges that landed on the release branch
 * count, so work that merged straight into the default branch — before release mode was turned
 * on, or while it was off — never counts.
 */
export function releaseBatchItems(
  ctx: FactoryContext,
  project: Project,
  tuning: FactoryLoop["tuning"],
): FactoryItem[] {
  const target = targetBranchOf(project, tuning);
  return ctx.store
    .items(project.id, ["watching", "merged"])
    .filter((i) => i.mergeSha && !isReleased(i) && mergedOnBranch(i) === target);
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
  releasedSha: null,
  released: [],
  ownerChecks: { state: "skipped", count: 0, failed: [] },
  canRelease: false,
  blockReason: null,
  updatedAt: null,
};

/** CI on the default branch failed on it: a red default branch pauses release approval. */
async function defaultBranchRed(
  ctx: FactoryContext,
  project: Project,
  base: string,
): Promise<boolean> {
  // Read once per tick, like the merge queue's reads (`main-ci.ts`).
  const main = await ctx.mainCi.head(ctx.github, project.id, base);
  return main?.checks === "failure";
}

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
    if (loop.release.batch.length > 0 || loop.release.canRelease || loop.release.releasedSha) {
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
  const batch = releaseBatchItems(ctx, project, loop.tuning);
  // A released batch the default branch hasn't verified yet (the release merge's commit).
  let pendingSha: string | null = loop.release.releasedSha ?? null;
  let pending: FactoryItem[] =
    pendingSha != null ? loop.release.released.flatMap((b) => ctx.store.item(b.itemId) ?? []) : [];
  // The release merge's CI on the default branch (spec 3): green clears it, red regresses.
  let justVerified = false;
  if (pendingSha != null) {
    const state = await ctx.github.commitChecks(project.id, pendingSha).catch(() => "none");
    if (state === "success") {
      pendingSha = null;
      pending = [];
      justVerified = true;
    } else if (state === "failure") {
      return releaseRegression(
        ctx,
        project,
        loop,
        target,
        base,
        pendingSha,
        pending,
        head.sha,
        now,
      );
    }
  }
  if (batch.length === 0 && pendingSha == null) {
    const open = ctx.inbox.find(releaseInboxId(project.id));
    if (open?.status === "open")
      ctx.inbox.close(open, "resolved", {
        note: justVerified ? `released and CI on ${base} is green` : "released",
      });
    return {
      ...loop,
      release: { ...EMPTY_SNAPSHOT, branch: target, headSha: head.sha, updatedAt: now },
    };
  }
  const pendingRelease =
    pendingSha != null ? { sha: pendingSha, items: pending.map(toBatchItem) } : null;
  const ci = head.checks as FactoryReleaseSnapshot["ci"];
  if (ci !== "success") {
    const snapshot: FactoryReleaseSnapshot = {
      ...EMPTY_SNAPSHOT,
      branch: target,
      headSha: head.sha,
      ci,
      batch: batch.map(toBatchItem),
      releasedSha: pendingRelease?.sha ?? null,
      released: pendingRelease?.items ?? [],
      blockReason:
        ci === "failure"
          ? `CI on ${target} is red (${head.failed.slice(0, 5).join(", ") || "failing checks"}): the batch can't be released until it is green again`
          : `Waiting for CI on ${target} (${head.sha.slice(0, 7)})`,
      updatedAt: now,
    };
    settleReleaseInbox(ctx, project, base, snapshot, batch, pending);
    return { ...loop, release: snapshot };
  }
  // A red default branch pauses release approval (spec 4): the merge would land on red.
  if (batch.length > 0 && (await defaultBranchRed(ctx, project, base))) {
    const snapshot: FactoryReleaseSnapshot = {
      ...EMPTY_SNAPSHOT,
      branch: target,
      headSha: head.sha,
      ci,
      batch: batch.map(toBatchItem),
      releasedSha: pendingRelease?.sha ?? null,
      released: pendingRelease?.items ?? [],
      blockReason: `CI on ${base} is red: the batch can't be released until it is green again`,
      updatedAt: now,
    };
    settleReleaseInbox(ctx, project, base, snapshot, batch, pending);
    return { ...loop, release: snapshot };
  }
  // CI is green on the release head: the batch's owner checks decide.
  const owner = await readBatchOwner(ctx, project, loop, head.sha);
  if (owner.state === "not_run") await startBatchTryout(ctx, project, target, head.sha);
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
    batch: batch.map(toBatchItem),
    releasedSha: pendingRelease?.sha ?? null,
    released: pendingRelease?.items ?? [],
    ownerChecks: { state: owner.state, count: owner.count, failed: owner.failed },
    canRelease: owner.state === "pass" || owner.state === "skipped",
    blockReason,
    updatedAt: now,
  };
  settleReleaseInbox(ctx, project, base, snapshot, batch, pending);
  return { ...loop, release: snapshot };
}

function toBatchItem(i: FactoryItem): FactoryReleaseBatchItem {
  return {
    itemId: i.id,
    title: i.title,
    prNumber: i.pr?.number ?? 0,
    url: i.pr?.url ?? "",
    mergedAt: i.mergedAt ?? i.updatedAt,
  };
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
    return {
      state: "skipped",
      count: 0,
      failed: [],
      why: "the project has no owner checks",
    };
  const dev = await projectDevServerAtHead(project, { exec: ctx.exec, head: headSha });
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

/**
 * CI on the default branch failed on the release merge (spec 3): the existing auto-revert
 * answers, against the default branch (spec 4). The released batch goes back to its builders
 * as revise rounds once the revert lands, exactly like a reverted merge.
 */
async function releaseRegression(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  target: string,
  base: string,
  releasedSha: string,
  released: FactoryItem[],
  headSha: string,
  now: string,
): Promise<FactoryLoop> {
  const at = now;
  const n = released.length;
  const releaseName = `release of ${n} change${n === 1 ? "" : "s"}`;
  const failed = released[0]
    ? await recordMainFailure(ctx, project, released[0], releasedSha)
    : await ctx.github.failedChecks(project.id, releasedSha).catch(() => []);
  // Fast merges wait until CI on the default branch is green again (`fast-merge.ts`).
  const next: FactoryLoop = {
    ...loop,
    consecutiveFailures: loop.consecutiveFailures + 1,
    fastMergeHold: `CI on ${base} failed after the release merged`,
  };
  // A release merge has two parents, so the API can't revert it: an agent always writes the
  // revert, with `-m 1` for the merge commit.
  const agent = revertAgent(ctx, project, loop);
  const merge = {
    sha: releasedSha,
    prNumber: 0,
    title: releaseName,
    mergeCommit: true as const,
    label: `the release ${releasedSha.slice(0, 7)}`,
  };
  const started =
    "waiting" in agent ? agent : await startRevertAgent(ctx, project, loop, merge, agent);
  const sessionId = "sessionId" in started ? started.sessionId : null;
  const revert = ctx.store.createItem({
    projectId: project.id,
    workKey: `factory:revert:${releasedSha.slice(0, 7)}`,
    title: releaseName,
    summary: `CI on ${base} failed after the release merged (${releasedSha}).`,
    source: "revert",
    stage: sessionId ? "building" : "backlog",
    builderSessionId: sessionId,
    builderProvider: "sessionId" in started ? started.provider : null,
    revertOf: released[0]?.id ?? null,
    note: sessionId
      ? "An agent is writing the revert"
      : "waiting" in started
        ? started.waiting
        : "the revert couldn't start yet: it starts again on the next free agent",
    nudges: { [`${REVERT_RELEASE}${releasedSha}`]: at },
  });
  const revertNote =
    sessionId != null
      ? "an agent is writing the revert PR"
      : "waiting" in started
        ? "no provider is available to write the revert yet: it starts as soon as one is"
        : "the revert couldn't start yet: it starts again on the next free agent";
  let unstarted: { revert: FactoryItem; why: string } | null = null;
  if ("why" in started) unstarted = { revert, why: started.why };
  for (const item of released) {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      stage: "reverted",
      reason: `CI on ${base} failed after the release${failed.length ? ` (${failed.join(", ")})` : ""}`,
      note: `CI on ${base} failed after the release; the revert is on its way`,
      finishedAt: at,
      nudges: { ...i.nudges, [REVERTED_AT]: at },
    }));
  }
  raiseInbox(ctx, {
    id: regressionInboxId(released[0]?.id ?? releasedSha),
    kind: "run_failed",
    notify: "failure",
    priority: "high",
    projectId: project.id,
    issue: released[0]?.issue ?? null,
    pr: null,
    title: `Factory regression on ${base}: ${releaseName}`,
    body: `CI on ${base} failed after the release merged (${releasedSha.slice(0, 7)}); ${revertNote}. The factory loop is paused: it resumes by itself once the revert merged and CI on ${base} is green again, and the released work goes back to its builder.`,
  });
  factoryNotice(ctx, {
    id: `factory.regression:${project.id}:${releasedSha.slice(0, 7)}`,
    projectId: project.id,
    target: "pm",
    event: "regression",
    title: `Regression after the release; loop paused`,
    text: `CI on ${base} failed after the release merged; ${revertNote}.`,
    itemIds: released.map((i) => i.id),
    wake: false,
  });
  // The regression pauses the loop (and resumes it once the revert landed, `revert.ts`).
  const prefix = regressionPausePrefix(base);
  const held = loop.pausedReason ?? "";
  const keep = loop.state === "paused" && !held.startsWith(prefix) && !held.startsWith("daily");
  const reason = `${prefix}release ${releasedSha.slice(0, 7)}; ${revertNote}`;
  const paused = keep ? next : pauseLoop(ctx, next, reason, { inbox: false });
  const open = ctx.inbox.find(releaseInboxId(project.id));
  if (open?.status === "open")
    ctx.inbox.close(open, "resolved", { note: `the release broke CI on ${base}` });
  const snapshot: FactoryReleaseSnapshot = {
    ...EMPTY_SNAPSHOT,
    branch: target,
    headSha,
    ci: "success",
    blockReason: `The release broke CI on ${base}: the revert is on its way`,
    updatedAt: now,
  };
  const regressed = { ...paused, release: snapshot };
  if (!unstarted) return regressed;
  return revertStartFailed(ctx, project, regressed, unstarted.revert, unstarted.why);
}

/** The release inbox follows the batch: ready (needs you), released and watching, or waiting. */
function settleReleaseInbox(
  ctx: FactoryContext,
  project: Project,
  base: string,
  snapshot: FactoryReleaseSnapshot,
  batch: FactoryItem[],
  released: FactoryItem[],
): void {
  const lines = (items: FactoryItem[]) =>
    items.map((i) => `- ${i.title} (#${i.pr?.number ?? "?"})${i.pr?.url ? ` ${i.pr.url}` : ""}`);
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
        ...lines(batch),
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
  if (released.length > 0) {
    raiseInbox(ctx, {
      id: releaseInboxId(project.id),
      kind: "pr_review",
      notify: "factory",
      priority: "low",
      projectId: project.id,
      title: `Released ${released.length} change${released.length === 1 ? "" : "s"}: watching CI on ${base}`,
      body: [
        `Released ${snapshot.releasedSha?.slice(0, 7) ?? ""} into \`${base}\`; watching CI on it. The batch below went out with it.`,
        "",
        ...lines(released),
      ].join("\n"),
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
    body: [`${snapshot.blockReason ?? "Not ready yet."}`, "", ...lines(batch)].join("\n"),
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
  const batch = releaseBatchItems(ctx, project, loop.tuning);
  if (batch.length === 0) throw conflict("There is nothing to release", "release_not_ready");
  if (head.checks !== "success") {
    throw conflict("CI on the release branch is not green", "release_not_ready");
  }
  const owner = await readBatchOwner(ctx, project, loop, headSha);
  if (owner.state !== "pass" && owner.state !== "skipped") {
    throw conflict("The batch's owner checks haven't passed", "release_not_ready");
  }
  // A red default branch pauses release approval: the merge would land on red (spec 4).
  if (await defaultBranchRed(ctx, project, base)) {
    throw conflict(
      `CI on ${base} is red: the batch can't be released until it is green again`,
      "release_not_ready",
    );
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
      // The merge commit, so the release revert can find the whole batch (`revertLanded`).
      // The release head stands in when the default branch already contained it.
      const mark = sha ?? headSha;
      return { ...i, nudges: { ...nudges, [`${RELEASED}${mark}`]: at } };
    });
  }
  if (!sha) {
    // The default branch already contains the release branch: nothing new went out.
    const open = ctx.inbox.find(releaseInboxId(projectId));
    if (open?.status === "open") ctx.inbox.close(open, "resolved", { note: "released" });
    const snapshot: FactoryReleaseSnapshot = {
      ...EMPTY_SNAPSHOT,
      branch: target,
      headSha,
      ci: "success",
      updatedAt: now,
    };
    ctx.store.saveTick({ ...loop, release: snapshot }, now);
    return snapshot;
  }
  const snapshot: FactoryReleaseSnapshot = {
    ...EMPTY_SNAPSHOT,
    branch: target,
    headSha: sha,
    ci: "success",
    releasedSha: sha,
    released: batch.map(toBatchItem),
    ownerChecks: { state: owner.state, count: owner.count, failed: owner.failed },
    updatedAt: now,
  };
  settleReleaseInbox(ctx, project, base, snapshot, [], batch);
  ctx.store.saveTick({ ...loop, release: snapshot }, now);
  return snapshot;
}
