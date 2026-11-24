import {
  AutomationRun,
  type AutomationRunStatus,
  HOME_RUNNER_ID,
  type ListAutomationRunsQuery,
  type Session,
  type TurnStatus,
} from "@codeden/contracts";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  max,
  min,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../../db/client";
import { automationRuns, events, runners, sessions, turns } from "../../db/schema";
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

/** Runner states in which its sessions get no events (a paused or starting one may come back). */
const RUNNER_GONE: ReadonlySet<string> = new Set(["disconnected", "stopped", "failed", "deleted"]);

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

  /** The newest run of an automation, in one project when `projectId` is given, else in any. */
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

  /**
   * Active runs given up on: the session was cut off (`interrupted`) before `now` minus the
   * limit, or it still reads running/waiting on a runner that has been disconnected that long
   * (a killed runner reports no exit). The cut-off is dated from the moment the session became
   * interrupted, never from `updatedAt`, which a title, PR link, note or model change also moves.
   */
  stranded(now: Date): AutomationRun[] {
    const before = new Date(now.getTime() - INTERRUPTED_RUN_LIMIT_MS).toISOString();
    const rows = this.db
      .select({ run: automationRuns, session: sessions, runner: runners })
      .from(automationRuns)
      .innerJoin(sessions, eq(sessions.id, automationRuns.sessionId))
      .leftJoin(
        runners,
        sessions.runnerId
          ? eq(runners.runnerId, sessions.runnerId)
          : eq(runners.id, HOME_RUNNER_ID),
      )
      .where(
        and(
          inArray(automationRuns.status, [...ACTIVE_RUN]),
          inArray(sessions.status, ["interrupted", "running", "waiting"]),
        ),
      )
      .all();
    return rows
      .filter(({ session, runner }) => {
        if (session.status === "interrupted") {
          return this.interruptedSince(session.id, session.createdAt) < before;
        }
        // running / waiting: only when its runner is gone, and gone for the whole limit.
        if (!runner || !RUNNER_GONE.has(runner.state)) return false;
        return !!runner.lastSeenAt && runner.lastSeenAt < before;
      })
      .map((r) => toRun(r.run));
  }

  /**
   * When the session became `interrupted`: the first `session.updated` of its current
   * interrupted stretch (after the last update that left any other status). Later writes to
   * the session (title, PR link) are interrupted-status updates too and don't move it.
   * `fallback` when no such event exists.
   */
  private interruptedSince(sessionId: string, fallback: string): string {
    const status = sql`json_extract(${events.payload}, '$.session.status')`;
    const mine = and(eq(events.sessionId, sessionId), eq(events.type, "session.updated"));
    const left = this.db
      .select({ seq: max(events.seq) })
      .from(events)
      .where(and(mine, sql`${status} != 'interrupted'`))
      .get();
    const first = this.db
      .select({ ts: min(events.ts) })
      .from(events)
      .where(and(mine, sql`${status} = 'interrupted'`, gt(events.seq, left?.seq ?? 0)))
      .get();
    return first?.ts ?? fallback;
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
