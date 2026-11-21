import { randomUUID } from "node:crypto";
import type { FactoryItem, FactoryLoop, OwnerCheckRun, Project, Session } from "@codeden/contracts";
import { conflict, errorMessage } from "../errors";
import type { FactoryContext } from "./context";
import type { FactoryPr } from "./github-port";
import { failItem } from "./outcomes";
import { projectDevServerAtHead } from "./owner-checks";
import { tryoutNudge, tryoutPrompt } from "./prompts-owner-checks";
import { pickReviewer } from "./reviewer-choice";
import { isBusy } from "./sessions";
import { claimSlot, reviewTier } from "./slots";

/**
 * The tryout agent (§10.1, Owner checks): a fresh session, never the builder or the reviewer, on
 * the branch it tries, which starts the app and tries the owner's scenarios in the browser. The
 * factory starts one once every other merge check passed; "Run owner checks" starts one by hand.
 */

/** Session statuses of a tryout that is no longer working. */
const ENDED = new Set(["idle", "interrupted", "completed", "failed", "stopped"]);

/** How long after a nudge an ended tryout counts as having ended again. */
const NUDGE_GRACE_MS = 60_000;

/** How long after a tryout failed to start the factory starts one again on the same head. */
const RESTART_AFTER_MS = 5 * 60_000;

/** What a run tries. */
export interface TryoutRequest {
  source: OwnerCheckRun["source"];
  item: FactoryItem | null;
  prNumber: number | null;
  headSha: string | null;
  forSessionId: string | null;
  /** The branch to check out: a PR's head branch (fetched) or a session's local branch. */
  branch: string;
  fetch: boolean;
  /** "pull request #12" / "the branch `x`", for the brief and the session's title. */
  label: string;
}

/**
 * Start a tryout run: the run record, then its session. Throws `conflict` when the project has
 * no owner checks, no `devServer`, or no provider is available (manual runs show it).
 */
export async function startTryout(
  ctx: FactoryContext,
  project: Project,
  req: TryoutRequest,
): Promise<OwnerCheckRun> {
  const checks = ctx.store.ownerChecks.checks(project.id);
  if (checks.length === 0) throw conflict("The project has no owner checks", "no_owner_checks");
  const lastRun = req.item ? ctx.store.ownerChecks.latestForItem(req.item.id) : null;
  const lastSession = lastRun?.sessionId ? ctx.repo.find(lastRun.sessionId)?.session : undefined;
  const forSession = req.forSessionId ? ctx.repo.find(req.forSessionId)?.session : undefined;
  const worktree = lastSession?.worktreePath ?? forSession?.worktreePath ?? null;
  const head = req.headSha ?? (req.fetch ? `origin/${req.branch}` : req.branch);
  const dev = await projectDevServerAtHead(project, {
    exec: ctx.exec,
    head,
    worktree,
  });
  if (!dev) {
    throw conflict(
      "Set a devServer in .codeden/project.json so the app can be started",
      "no_dev_server",
    );
  }
  const loop = ctx.store.loopOrNew(project.id, ctx.now());
  const choice = pickReviewer({
    author: { provider: req.item?.builderProvider ?? null, model: null },
    tuning: loop.tuning,
    available: ctx.sessions.providers(),
    unavailable: ctx.sessions.unavailable(),
    name: (id) => ctx.sessions.displayName(id),
  });
  if (choice.wait) throw conflict(choice.note, "no_provider");
  const at = ctx.now().toISOString();
  const store = ctx.store.ownerChecks;
  let run = store.saveRun({
    id: randomUUID(),
    projectId: project.id,
    source: req.source,
    itemId: req.item?.id ?? null,
    prNumber: req.prNumber,
    headSha: req.headSha,
    forSessionId: req.forSessionId,
    sessionId: null,
    checkIds: checks.map((c) => c.id),
    state: "running",
    results: [],
    detail: null,
    nudgedAt: null,
    startedAt: at,
    endedAt: null,
  });
  const key =
    req.prNumber !== null ? `pr-${req.prNumber}` : `s-${(req.forSessionId ?? run.id).slice(0, 8)}`;
  let res: Awaited<ReturnType<FactoryContext["sessions"]["startTryout"]>> | null = null;
  let why: string | null = null;
  try {
    res = await ctx.sessions.startTryout(
      project.id,
      { key, title: req.label, branch: req.branch, fetch: req.fetch },
      tryoutPrompt({ label: req.label }, checks, dev),
      choice,
    );
    if (res.status !== "started") why = `the tryout session didn't start (${res.status})`;
  } catch (error) {
    why = `the tryout session didn't start: ${errorMessage(error)}`;
  }
  if (why || !res || res.status !== "started") {
    run = store.saveRun({ ...run, state: "error", detail: why, endedAt: ctx.now().toISOString() });
    return run;
  }
  run = store.saveRun({ ...run, sessionId: res.sessionId });
  if (req.item) {
    const sessionId = res.sessionId;
    // The tryout's cost counts toward the item, and it is archived once idle and done.
    ctx.store.updateItem(req.item.id, (i) => ({
      ...i,
      earlierSessionIds: [...new Set([...i.earlierSessionIds, sessionId])],
    }));
  }
  return run;
}

/**
 * The factory's step while `owner_checks` is the only check left (§10.1): start the tryout on
 * the PR's head, wait while it works, nudge it once when it ends its turn without results, and
 * fail the item as an infrastructure failure (no revise round) when it ends again.
 */
export async function advanceOwnerChecks(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  pr: FactoryPr,
): Promise<FactoryLoop> {
  const store = ctx.store.ownerChecks;
  const last = store.latestForItem(item.id);
  const current = last && last.state === "running" && last.headSha === pr.headSha ? last : null;
  if (!current) {
    // A start that just failed on this head is tried again a little later, not every tick.
    const failedAt = last?.state === "error" && last.headSha === pr.headSha ? last.endedAt : null;
    if (failedAt && ctx.now().getTime() - Date.parse(failedAt) < RESTART_AFTER_MS) return loop;
    if (!claimSlot(ctx, project, reviewTier(item.checks), `tryout:${item.id}`)) {
      ctx.store.updateItem(
        item.id,
        (i) => ({ ...i, note: "Waiting for a free agent for the owner checks" }),
        {
          touch: false,
        },
      );
      return loop;
    }
    try {
      const run = await startTryout(ctx, project, {
        source: "factory",
        item,
        prNumber: pr.ref.number,
        headSha: pr.headSha,
        forSessionId: null,
        branch: pr.headBranch,
        fetch: true,
        label: `pull request #${pr.ref.number}`,
      });
      const note =
        run.state === "error"
          ? `Owner checks not started (${run.detail ?? "unknown"})`
          : "A tryout agent is trying the owner checks";
      ctx.store.updateItem(item.id, (i) => ({ ...i, note }));
    } catch (error) {
      ctx.store.updateItem(item.id, (i) => ({
        ...i,
        note: `Owner checks waiting: ${errorMessage(error)}`,
      }));
    }
    return loop;
  }
  if ((await followUpTryout(ctx, current)) === "working") return loop;
  const why = "the tryout agent ended without results";
  store.saveRun({ ...current, state: "error", detail: why, endedAt: ctx.now().toISOString() });
  return failItem(ctx, loop, item, `owner checks: ${why}; they run again on the retry`, {
    kind: "infrastructure",
  });
}

/** Whether a tryout session has stopped working: not busy, its turn ended, nothing on its way. */
export function tryoutStill(ctx: FactoryContext, session: Session): boolean {
  if (isBusy(session) || !ENDED.has(session.status)) return false;
  return !ctx.sessions.hasPendingMessage(session.id);
}

/**
 * The follow-up of a running tryout, for factory and manual runs alike: "working" while it
 * works, after its one nudge (sent here when it first ends its turn without results) and during
 * the grace after it; "ended" once it ended again without results, or its session is gone.
 */
export async function followUpTryout(
  ctx: FactoryContext,
  run: OwnerCheckRun,
  opts: { nudge?: boolean } = {},
): Promise<"working" | "ended"> {
  const session = run.sessionId ? ctx.repo.find(run.sessionId)?.session : undefined;
  if (session && !session.archivedAt && (isBusy(session) || !ENDED.has(session.status)))
    return "working";
  if (session && ctx.sessions.hasPendingMessage(session.id)) return "working";
  const now = ctx.now();
  if (session && !session.archivedAt && !run.nudgedAt) {
    if (opts.nudge === false) return "working";
    await ctx.sessions.message(session.id, tryoutNudge(run.checkIds.length));
    ctx.store.ownerChecks.saveRun({ ...run, nudgedAt: now.toISOString() });
    return "working";
  }
  if (run.nudgedAt && now.getTime() - Date.parse(run.nudgedAt) < NUDGE_GRACE_MS) return "working";
  return "ended";
}
