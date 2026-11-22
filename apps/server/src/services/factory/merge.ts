import type { FactoryItem, FactoryLoop, GitHubPrRef, MergePath, Project } from "@codeden/contracts";
import { errorMessage, ServiceError } from "../errors";
import {
  type FactoryContext,
  factoryNotice,
  MERGED_ON,
  raiseInbox,
  releaseModeOn,
  targetBranchOf,
} from "./context";
import { followUpsAtMerge } from "./follow-ups";
import type { FactoryPr } from "./github-port";
import { spotCheckAtMerge } from "./spot-checks";
import { stuckDecisionId, stuckInboxId } from "./stuck";

/**
 * The Merge step (§10.1): every check passed. With auto-merge on and trusted work, the factory
 * squash-merges and watches the default branch; otherwise the pull request is the user's to
 * merge on GitHub ("ready for you"). Also what happens when a person merges or closes it.
 */

/** Inbox id of "ready for you to merge". */
export const readyInboxId = (itemId: string) => `inbox:factory-ready:${itemId}`;

/** Inbox id of a PR escalated to the user (a protected area). */
export const escalatedInboxId = (itemId: string) => `inbox:factory-escalated:${itemId}`;

/** The inbox items about an item's PR: ready to merge, protected area, stuck (and its dark-factory decision). */
export function prInboxIds(itemId: string): string[] {
  return [
    readyInboxId(itemId),
    escalatedInboxId(itemId),
    stuckInboxId(itemId),
    stuckDecisionId(itemId),
  ];
}

/**
 * Resolve the open inbox items about an item's PR once it is decided or replaced. A resolved
 * decision stays on record (the digest still lists it); it just no longer waits on the user.
 */
export function closeInboxFor(ctx: FactoryContext, itemId: string, note: string): void {
  for (const id of prInboxIds(itemId)) {
    const open = ctx.inbox.find(id);
    if (open?.status === "open") ctx.inbox.close(open, "resolved", { note });
  }
}

/** Point the open inbox items about an item's PR at the PR that replaced it. */
export function retargetInboxFor(ctx: FactoryContext, itemId: string, pr: GitHubPrRef): void {
  for (const id of prInboxIds(itemId)) {
    const open = ctx.inbox.find(id);
    if (open?.status !== "open" || open.pr?.number === pr.number) continue;
    ctx.inbox.put({ ...open, pr, updatedAt: ctx.now().toISOString() });
  }
}

/**
 * The item's PR merged or closed: the factory's requests still waiting in its agent's queue (a
 * rebase, a revise round, a push to start CI) no longer apply, so none is delivered after the
 * merge. Messages from a person or the PM stay.
 */
export function withdrawRequests(ctx: FactoryContext, item: FactoryItem): void {
  if (!item.builderSessionId) return;
  const n = ctx.sessions.withdrawQueued(item.builderSessionId);
  if (n > 0) {
    const what = item.pr ? `#${item.pr.number}` : "its PR";
    ctx.log?.(`factory: ${item.id}: withdrew ${n} queued request(s) after ${what} was decided`);
  }
}

/** The PR was merged or closed by someone (a person, on GitHub). */
export function prDecidedOutside(
  ctx: FactoryContext,
  item: FactoryItem,
  ref: NonNullable<FactoryItem["pr"]>,
): void {
  withdrawRequests(ctx, item);
  const at = ctx.now().toISOString();
  const merged = ref.state === "merged";
  // A person merged it: only the merges always spot-checked are set aside (`spot-checks.ts`).
  const project = merged ? ctx.projects.get(item.projectId) : null;
  const loop = project ? ctx.store.loopOrNew(project.id, ctx.now()) : null;
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    ...(merged ? followUpsAtMerge(i, at) : {}),
    ...(project && loop ? spotCheckAtMerge(project, loop, i, at, false) : {}),
    pr: ref,
    stage: merged ? "merged" : "rejected",
    // A protected area stays the reason it was a person's to merge.
    reason: merged
      ? i.stage === "escalated"
        ? i.reason
        : null
      : "The pull request was closed on GitHub",
    failureKind: null,
    note: merged ? "Merged on GitHub" : null,
    mergedAt: merged ? (i.mergedAt ?? at) : i.mergedAt,
    finishedAt: i.finishedAt ?? at,
  }));
  closeInboxFor(ctx, item.id, merged ? "merged" : "closed");
}

/** Every check passed and the factory doesn't merge this one: it's the user's to merge. */
export async function readyForYou(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
): Promise<void> {
  const why =
    item.trust === "admitted"
      ? "it came from an untrusted author, so a person merges it"
      : "auto-merge is off";
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    note: `Ready to merge: every check passed (${why})`,
  }));
  if (item.nudges.ready) return;
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => ({ ...i, nudges: { ...i.nudges, ready: at } }));
  const passed = item.checks
    .filter((c) => c.state === "pass")
    .map((c) => c.name)
    .join(", ");
  raiseInbox(ctx, {
    id: readyInboxId(item.id),
    kind: "pr_review",
    // The factory won't merge this one: a person has to.
    notify: "needs_you",
    priority: "normal",
    projectId: project.id,
    sessionId: item.builderSessionId,
    issue: item.issue,
    pr: item.pr,
    title: `Ready to merge: ${item.title}`,
    body: `Every factory check passed (${passed}); ${why}. Review the evidence on the pull request and merge it on GitHub.`,
  });
  if (item.pr) {
    await ctx.github
      .comment(
        project.id,
        item.pr.number,
        `Every CodeDen software factory check passed (${passed}). Ready for a maintainer to review and merge.`,
      )
      .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
  }
  factoryNotice(ctx, {
    id: `factory.ready:${item.id}`,
    projectId: project.id,
    target: "pm",
    event: "ready",
    title: `Ready for the user to merge #${item.pr?.number ?? "?"}: ${item.title}`,
    text: `Every check passed; ${why}.`,
    itemIds: [item.id],
    wake: false,
  });
}

/** The error codes GitHub's refusals to merge or update a PR map to (`toGithubError`). */
const REFUSAL_CODES = new Set([
  "github_not_allowed", // 405: not mergeable, a required status check is expected
  "github_conflict", // 409: the head moved, a merge conflict
  "github_validation", // 422
  "github_forbidden", // 403 without a rate limit: e.g. "Resource not accessible by integration"
]);

/**
 * Whether GitHub answered and refused the request, as opposed to not answering properly: a
 * rate limit, a 5xx or network failure, or GitHub not being connected. Only refusals count
 * against a PR in the merge queue; the rest is tried again on the next tick.
 */
export function githubRefused(error: unknown): boolean {
  if (baseJustMoved(error)) return false;
  return error instanceof ServiceError && REFUSAL_CODES.has(error.code);
}

/** GitHub's answer to a merge sent while it still works out the PR against a base that moved. */
const BASE_MOVED = /base branch was modified/i;

/**
 * Whether GitHub turned a merge down only because the default branch moved a moment ago (the
 * merge before it in the queue): it hasn't worked out the PR against the new base yet. Never a
 * refusal: the same merge goes through seconds later.
 */
export function baseJustMoved(error: unknown): boolean {
  return BASE_MOVED.test(errorMessage(error));
}

/**
 * `merged_after_<itemId>`: that item's merge was still being watched (CI on the default branch
 * not finished) when this one merged, so this one stacked on an unverified main (`progress.ts`).
 */
export const MERGED_AFTER = "merged_after_";

/**
 * What GitHub said when it didn't merge a queued PR; `refusal` when it refused it, `settling`
 * when it only hasn't caught up with the default branch moving (`baseJustMoved`).
 */
export interface MergeFailed {
  failed: string;
  refusal: boolean;
  settling: boolean;
}

/**
 * The merge did not happen and must not be retried as a failure: the PR's base isn't the
 * branch release mode merges into. `held` is the note to show.
 */
export interface MergeHeld {
  held: string;
}

/** When the factory moved the PR onto the release branch (ISO time); see `startedAfter`. */
export const RETARGETED = "retargeted_base";

/** Whether every check on the PR started after `since`; unknown times don't count. */
function startedAfter(pr: FactoryPr, since: string): boolean {
  if (pr.checks !== "success" || !pr.checksStartedAt) return false;
  return Date.parse(pr.checksStartedAt) > Date.parse(since);
}

/**
 * Squash-merge a queued PR, recording how it got there (`path`). When GitHub doesn't merge it,
 * nothing changes here: what it said comes back, and the queue counts the refusals (`queue.ts`).
 */
export async function autoMerge(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  current: FactoryItem,
  pr: FactoryPr,
  checks: FactoryItem["checks"],
  how: { path: MergePath; note?: string },
): Promise<FactoryLoop | MergeFailed | MergeHeld> {
  const target = targetBranchOf(project, loop.tuning);
  // Release mode merges only into the release branch. A PR still aimed at the default branch
  // (open before the switch, or opened without the brief's base) is moved there and not merged
  // this tick, so CI runs against the release branch first. GitHub squash-merges into the PR's
  // own base, so merging it now would land it on the default branch and skip the batch.
  if (releaseModeOn(project, loop.tuning) && pr.baseBranch && pr.baseBranch !== target) {
    return { held: await retargetRelease(ctx, project, current, pr, target) };
  }
  // The head SHA doesn't change when the base does, so GitHub still reports the checks that ran
  // against the old base. Only checks that started after the retarget count as proof.
  const retargetedAt = current.nudges[RETARGETED];
  if (retargetedAt && releaseModeOn(project, loop.tuning) && !startedAfter(pr, retargetedAt)) {
    return {
      held: `Waiting for CI to run on ${target} after it was retargeted; earlier results don't count`,
    };
  }
  const title = `${current.title} (#${pr.ref.number})`;
  const res = await ctx.github
    .merge(project.id, pr.ref.number, { sha: pr.headSha, title })
    .catch((error: unknown) => ({
      merged: false,
      sha: null,
      error: errorMessage(error),
      refusal: githubRefused(error),
      settling: baseJustMoved(error),
    }));
  if (!res.merged) {
    // A 200 with `merged: false` is GitHub's own answer.
    if (!("error" in res))
      return { failed: "GitHub did not merge it", refusal: true, settling: false };
    return { failed: res.error, refusal: res.refusal, settling: res.settling };
  }
  const at = ctx.now().toISOString();
  // Merges whose CI on the target branch is still running: a failure is theirs to answer first.
  const unverified = ctx.store
    .items(project.id, ["watching"])
    .filter((i) => i.id !== current.id)
    .map((i) => [`${MERGED_AFTER}${i.id}`, at]);
  // Where the squash actually landed: the PR's base, not the branch the settings name.
  const landedOn = pr.baseBranch ?? target;
  ctx.store.updateItem(current.id, (i) => {
    const kept = followUpsAtMerge(i, at);
    return {
      ...i,
      // A share of automatic merges is set aside for a person's quick look (`spot-checks.ts`).
      ...spotCheckAtMerge(project, loop, i, at, true),
      stage: "watching",
      pr: { ...pr.ref, state: "merged" },
      mergeSha: res.sha,
      mergePath: how.path,
      mergedAt: at,
      note: how.note ?? `Merged; watching CI on ${landedOn}`,
      followUps: kept.followUps,
      nudges: {
        ...kept.nudges,
        ...Object.fromEntries(unverified),
        ...(res.sha ? { [`${MERGED_ON}${res.sha.slice(0, 12)}_${landedOn}`]: at } : {}),
      },
    };
  });
  withdrawRequests(ctx, current);
  const ready = ctx.inbox.find(readyInboxId(current.id));
  if (ready?.status === "open") ctx.inbox.close(ready, "resolved", { note: "merged" });
  if (current.issue && current.source !== "revert") {
    const passed = checks
      .filter((c) => c.state === "pass")
      .map((c) => c.name)
      .join(", ");
    await ctx.github
      .comment(
        project.id,
        current.issue.number,
        `Merged automatically by the CodeDen factory in #${pr.ref.number} after every merge check passed (${passed}).`,
      )
      .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
  }
  factoryNotice(ctx, {
    id: `factory.merged:${current.id}`,
    projectId: project.id,
    target: "pm",
    event: "merged",
    title: `Factory merged #${pr.ref.number}: ${current.title}`,
    text: `Merged ${pr.ref.url} (${res.sha ?? "unknown sha"}); watching CI on ${landedOn}.`,
    itemIds: [current.id],
    wake: false,
  });
  return {
    ...loop,
    mergesToday: loop.mergesToday + 1,
    consecutiveFailures: 0,
    evidenceFailures: 0,
  };
}

/**
 * Move a pull request onto the release branch. It is not merged this tick either way: CI on the
 * new base has to run first. When GitHub won't move it, the note says so and it stays put.
 */
async function retargetRelease(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  pr: FactoryPr,
  target: string,
): Promise<string> {
  const from = pr.baseBranch ?? "its base";
  try {
    await ctx.github.ensureBranch(project.id, target);
    await ctx.github.setBase(project.id, pr.ref.number, target);
    const at = ctx.now().toISOString();
    ctx.store.updateItem(item.id, (i) => ({ ...i, nudges: { ...i.nudges, [RETARGETED]: at } }));
    return `Retargeted onto ${target} (it targeted ${from}); it isn't merged until CI is green on that base`;
  } catch (error) {
    return `Its base is ${from}, not ${target}, so it isn't merged. Point it at ${target} (${errorMessage(error)})`;
  }
}
