import {
  AutomationRun,
  type AutomationRunStatus,
  type ListAutomationRunsQuery,
  type Session,
  type TurnStatus,
} from "@codeden/contracts";
import { and, desc, eq, gte, inArray, isNotNull, lt, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client";
import { automationRuns, sessions, turns } from "../../db/schema";
import { turnsNewestFirst } from "../../db/turn-order";
import type { EventStore } from "../../events/store";
import { notFound } from "../errors";
import { localDay } from "./cron";

/** Run statuses that are still in progress. */
export const ACTIVE_RUN: readonly AutomationRunStatus[] = ["queued", "running"];
/** Run statuses that count against the daily cap. */
const COUNTED: readonly AutomationRunStatus[] = ["queued", "running", "completed", "failed"];

/**
 * How long a run's session may stay `interrupted` (its runner gone) before the run is given up
 * on. A runner restart takes seconds to minutes, so a full day is far past any normal resume.
 */
export const INTERRUPTED_RUN_LIMIT_MS = 24 * 3600_000;

/** Status of a session's latest root-thread turn (how an idle session's run ended). */
export function lastTurnStatus(db: Db, session: Session): TurnStatus | null {
  if (!session.rootThreadId) return null;
  const row = db
    .select({ status: turns.status })
    .from(turns)
    .where(and(eq(turns.sessionId, session.id), eq(turns.threadId, session.rootThreadId)))
    .orderBy(...turnsNewestFirst)
    .limit(1)
    .get();
  return (row?.status as TurnStatus | undefined) ?? null;
}

function toRun(row: typeof automationRuns.$inferSelect): AutomationRun {
  return AutomationRun.parse(row);
}

/** `automation_run` rows (§8.4, §10), written through `automation_run.updated` events. */
export class RunStore {
  constructor(
    private readonly db: Db,
    private readonly store: EventStore,
  ) {}

  save(run: AutomationRun): AutomationRun {
    const parsed = AutomationRun.parse(run);
    this.store.append([
      { type: "automation_run.updated", sessionId: null, payload: { run: parsed } },
    ]);
    return parsed;
  }

  find(id: string): AutomationRun | undefined {
    const row = this.db.select().from(automationRuns).where(eq(automationRuns.id, id)).get();
    return row ? toRun(row) : undefined;
  }

  get(id: string): AutomationRun {
    const run = this.find(id);
    if (!run) throw notFound(`No automation run ${id}`, "automation_run_not_found");
    return run;
  }

  list(query: Partial<ListAutomationRunsQuery> = {}): AutomationRun[] {
    const conditions: SQL[] = [];
    if (query.projectId) conditions.push(eq(automationRuns.projectId, query.projectId));
    if (query.automationId) conditions.push(eq(automationRuns.automationId, query.automationId));
    if (query.status) conditions.push(eq(automationRuns.status, query.status));
    return this.db
      .select()
      .from(automationRuns)
      .where(and(...conditions))
      .orderBy(desc(automationRuns.startedAt))
      .limit(query.limit ?? 50)
      .all()
      .map(toRun);
  }

  /** The newest run of an automation, in one project when `projectId` is given. */
  latest(automationId: string, projectId?: string): AutomationRun | null {
    return this.list({ automationId, projectId, limit: 1 })[0] ?? null;
  }

  /**
   * Queued or running runs of one automation in one project, not counting runs whose session
   * has stayed interrupted past {@link INTERRUPTED_RUN_LIMIT_MS} (they never resumed).
   */
  activeCount(automationId: string, projectId: string, now: Date = new Date()): number {
    const stranded = new Set(this.stranded(now).map((r) => r.id));
    return this.db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, automationId),
          eq(automationRuns.projectId, projectId),
          inArray(automationRuns.status, [...ACTIVE_RUN]),
        ),
      )
      .all()
      .filter((r) => !stranded.has(r.id)).length;
  }

  /** Active runs whose session has been `interrupted` since before `now` minus the limit. */
  stranded(now: Date): AutomationRun[] {
    const before = new Date(now.getTime() - INTERRUPTED_RUN_LIMIT_MS).toISOString();
    return this.db
      .select({ run: automationRuns })
      .from(automationRuns)
      .innerJoin(sessions, eq(sessions.id, automationRuns.sessionId))
      .where(
        and(
          inArray(automationRuns.status, [...ACTIVE_RUN]),
          eq(sessions.status, "interrupted"),
          lt(sessions.updatedAt, before),
        ),
      )
      .all()
      .map((r) => toRun(r.run));
  }

  /** Runs that count against the daily cap on `now`'s local day in `tz`. */
  countToday(automationId: string, projectId: string, now: Date, tz: string): number {
    const since = new Date(now.getTime() - 48 * 3600_000).toISOString();
    const today = localDay(now, tz);
    return this.db
      .select({ startedAt: automationRuns.startedAt })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, automationId),
          eq(automationRuns.projectId, projectId),
          inArray(automationRuns.status, [...COUNTED]),
          gte(automationRuns.startedAt, since),
        ),
      )
      .all()
      .filter((r) => localDay(new Date(r.startedAt), tz) === today).length;
  }

  /** Running runs of a project about one issue (`issueNumber`), oldest first. */
  runningForIssue(projectId: string, issueNumber: number): AutomationRun[] {
    return this.db
      .select()
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.projectId, projectId),
          eq(automationRuns.issueNumber, issueNumber),
          eq(automationRuns.status, "running"),
        ),
      )
      .orderBy(automationRuns.startedAt)
      .all()
      .map(toRun);
  }

  /** Running runs of any automation started before `before` (ISO). */
  allRunningBefore(before: string): AutomationRun[] {
    return this.db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.status, "running"), lt(automationRuns.startedAt, before)))
      .all()
      .map(toRun);
  }

  /** Running runs of one automation in one project started before `before` (ISO). */
  runningBefore(automationId: string, projectId: string, before: string): AutomationRun[] {
    return this.db
      .select()
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, automationId),
          eq(automationRuns.projectId, projectId),
          eq(automationRuns.status, "running"),
          lt(automationRuns.startedAt, before),
        ),
      )
      .all()
      .map(toRun);
  }

  /** Active runs that track a session (rebuilds the session -> run map after a restart). */
  activeWithSession(): AutomationRun[] {
    return this.db
      .select()
      .from(automationRuns)
      .where(
        and(inArray(automationRuns.status, [...ACTIVE_RUN]), isNotNull(automationRuns.sessionId)),
      )
      .all()
      .map(toRun);
  }
}
