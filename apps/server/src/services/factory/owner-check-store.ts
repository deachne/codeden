import type { OwnerCheck, OwnerCheckRun } from "@codeden/contracts";
import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { sessions } from "../../db/schema-core";
import { factoryOwnerCheckRuns, factoryOwnerChecks } from "../../db/schema-factory";
import type { EventStore } from "../../events/store";

/**
 * The owner checks and their tryout runs (§10.1, Owner checks) over the event log: reads come
 * from the `factory_owner_check*` projections, writes append `factory.owner_check*` events. They
 * live in CodeDen's data folder only; nothing here reaches a builder's or reviewer's brief.
 */
export class OwnerCheckStore {
  constructor(
    private readonly db: Db,
    private readonly events: EventStore,
  ) {}

  /** The project's checks in force (not removed), in the order written: how a tryout numbers them. */
  checks(projectId: string): OwnerCheck[] {
    return (
      this.db
        .select()
        .from(factoryOwnerChecks)
        .where(
          and(eq(factoryOwnerChecks.projectId, projectId), isNull(factoryOwnerChecks.removedAt)),
        )
        // Written order: an edit (an upsert) keeps its row, so its number stays; checks written in
        // the same millisecond keep the order they were written in (never a random id's).
        .orderBy(asc(factoryOwnerChecks.createdAt), asc(sql`rowid`))
        .all()
        .map((r) => r.check)
    );
  }

  /** One check of the project, removed or not. */
  check(projectId: string, id: string): OwnerCheck | undefined {
    return this.db
      .select()
      .from(factoryOwnerChecks)
      .where(and(eq(factoryOwnerChecks.projectId, projectId), eq(factoryOwnerChecks.id, id)))
      .get()?.check;
  }

  /** Record a new check or a change to one (an upsert). */
  saveCheck(check: OwnerCheck): OwnerCheck {
    this.events.append([
      { type: "factory.owner_check.updated", sessionId: null, payload: { check } },
    ]);
    return check;
  }

  /** The project's latest runs, newest first. */
  runs(projectId: string, limit: number): OwnerCheckRun[] {
    return this.db
      .select()
      .from(factoryOwnerCheckRuns)
      .where(eq(factoryOwnerCheckRuns.projectId, projectId))
      .orderBy(desc(factoryOwnerCheckRuns.startedAt), desc(factoryOwnerCheckRuns.id))
      .limit(limit)
      .all()
      .map((r) => r.run);
  }

  /**
   * The project's manual runs that still need work (running, or ended with a tryout session
   * not yet archived), oldest first: the loop follows each up until it ended and its tryout
   * session is archived (`advanceManualTryouts`).
   */
  manualRuns(projectId: string): OwnerCheckRun[] {
    return this.db
      .select({ run: factoryOwnerCheckRuns.run })
      .from(factoryOwnerCheckRuns)
      .leftJoin(sessions, eq(factoryOwnerCheckRuns.sessionId, sessions.id))
      .where(
        and(
          eq(factoryOwnerCheckRuns.projectId, projectId),
          sql`json_extract(${factoryOwnerCheckRuns.run}, '$.source') = 'manual'`,
          or(
            sql`json_extract(${factoryOwnerCheckRuns.run}, '$.state') = 'running'`,
            and(
              isNotNull(factoryOwnerCheckRuns.sessionId),
              isNotNull(sessions.id),
              isNull(sessions.archivedAt),
            ),
          ),
        ),
      )
      .orderBy(asc(factoryOwnerCheckRuns.startedAt), asc(factoryOwnerCheckRuns.id))
      .all()
      .map((r) => r.run);
  }

  /** The newest run for a work item, any head; undefined when none. */
  latestForItem(itemId: string): OwnerCheckRun | undefined {
    return this.db
      .select()
      .from(factoryOwnerCheckRuns)
      .where(eq(factoryOwnerCheckRuns.itemId, itemId))
      .orderBy(desc(factoryOwnerCheckRuns.startedAt), desc(factoryOwnerCheckRuns.id))
      .limit(1)
      .get()?.run;
  }

  /** The run a tryout session works on. */
  runOfSession(sessionId: string): OwnerCheckRun | undefined {
    return this.db
      .select()
      .from(factoryOwnerCheckRuns)
      .where(eq(factoryOwnerCheckRuns.sessionId, sessionId))
      .orderBy(desc(factoryOwnerCheckRuns.startedAt))
      .limit(1)
      .get()?.run;
  }

  /** Record a new run or a change to one (an upsert). */
  saveRun(run: OwnerCheckRun): OwnerCheckRun {
    this.events.append([
      { type: "factory.owner_check_run.updated", sessionId: null, payload: { run } },
    ]);
    return run;
  }
}
