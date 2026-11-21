import type { OwnerCheckRun, Project, Session } from "@codeden/contracts";
import { errorMessage } from "../errors";
import type { FactoryContext } from "./context";
import { followUpTryout, tryoutStill } from "./owner-checks-run";

/**
 * Owner checks started by hand (§10.1, Owner checks; issue #17) and the release batch's tryouts
 * (`release.ts`, `source: "release"`, which name no item): every loop step follows them up as
 * it does the factory's own, in any autonomy mode and whether or not a work item owns them.
 * A running tryout is nudged once when it ends its turn without results, and its run is closed
 * ("no result") when it ends again; once the run ended, its tryout session is archived as soon
 * as it is idle, through the normal archive path, which removes its worktree.
 */

/** Whether the factory's own step for a work item follows this run up (`advanceOwnerChecks`). */
function itemDrives(ctx: FactoryContext, run: OwnerCheckRun): boolean {
  if (!run.itemId) return false;
  const item = ctx.store.item(run.itemId);
  if (item?.stage !== "verifying") return false;
  return ctx.store.ownerChecks.latestForItem(run.itemId)?.id === run.id;
}

/** Follow up the project's hand-started and release-batch tryouts; `nudge: false` (kill switch) sends the tryouts nothing. */
export async function advanceManualTryouts(
  ctx: FactoryContext,
  project: Project,
  opts: { nudge: boolean },
): Promise<void> {
  const toArchive: string[] = [];
  for (const run of ctx.store.ownerChecks.followUpRuns(project.id)) {
    const session = run.sessionId ? ctx.repo.find(run.sessionId)?.session : undefined;
    if (run.state === "running") {
      if (!run.sessionId || itemDrives(ctx, run)) continue;
      try {
        if ((await followUpTryout(ctx, run, { nudge: opts.nudge })) === "working") continue;
      } catch (error) {
        ctx.log?.(`factory: owner checks run ${run.id}: ${errorMessage(error)}`);
        continue;
      }
      ctx.store.ownerChecks.saveRun({
        ...run,
        state: "error",
        detail: "the tryout agent ended without results",
        endedAt: ctx.now().toISOString(),
      });
      if (session && !session.archivedAt) toArchive.push(session.id);
      continue;
    }
    if (done(ctx, session)) toArchive.push((session as Session).id);
  }
  if (toArchive.length > 0) ctx.archiveSessions(toArchive);
}

/** A finished run's tryout that may be archived now: not archived yet, and idle. */
function done(ctx: FactoryContext, session: Session | undefined): boolean {
  return session !== undefined && !session.archivedAt && tryoutStill(ctx, session);
}
