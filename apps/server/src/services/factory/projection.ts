import type { EventOf } from "@codeden/contracts";
import {
  factoryDigests,
  factoryItems,
  factoryLessons,
  factoryLoops,
  factoryOwnerCheckRuns,
  factoryOwnerChecks,
  factoryParkedIdeas,
} from "../../db/schema-factory";
import type { Tx } from "../../events/projection-db";

type FactoryEvent = EventOf<
  | "factory.loop.updated"
  | "factory.item.updated"
  | "factory.digest.created"
  | "factory.lesson.updated"
  | "factory.parked_idea.updated"
  | "factory.owner_check.updated"
  | "factory.owner_check_run.updated"
>;

/** Project factory events (§10.1) inside the append transaction, so they can be rebuilt. */
export function applyFactoryProjection(tx: Tx, e: FactoryEvent): void {
  switch (e.type) {
    case "factory.loop.updated": {
      const { loop } = e.payload;
      const row = { projectId: loop.projectId, state: loop.state, loop, updatedAt: loop.updatedAt };
      tx.insert(factoryLoops)
        .values(row)
        .onConflictDoUpdate({ target: factoryLoops.projectId, set: row })
        .run();
      return;
    }
    case "factory.item.updated": {
      const { item } = e.payload;
      const row = {
        id: item.id,
        projectId: item.projectId,
        stage: item.stage,
        workKey: item.workKey,
        item,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
      tx.insert(factoryItems)
        .values(row)
        .onConflictDoUpdate({ target: factoryItems.id, set: row })
        .run();
      return;
    }
    case "factory.digest.created": {
      const { digest } = e.payload;
      tx.insert(factoryDigests)
        .values({
          id: digest.id,
          projectId: digest.projectId,
          day: digest.day,
          digest,
          createdAt: digest.createdAt,
        })
        .onConflictDoNothing()
        .run();
      return;
    }
    case "factory.lesson.updated": {
      const { lesson } = e.payload;
      const row = {
        id: lesson.id,
        projectId: lesson.projectId,
        key: lesson.key,
        lesson,
        lastSeenAt: lesson.lastSeenAt,
        removedAt: lesson.removedAt,
      };
      tx.insert(factoryLessons)
        .values(row)
        .onConflictDoUpdate({ target: factoryLessons.id, set: row })
        .run();
      return;
    }
    case "factory.parked_idea.updated": {
      const { idea } = e.payload;
      const row = {
        id: idea.id,
        projectId: idea.projectId,
        key: idea.key,
        status: idea.status,
        idea,
        createdAt: idea.createdAt,
      };
      tx.insert(factoryParkedIdeas)
        .values(row)
        .onConflictDoUpdate({ target: factoryParkedIdeas.id, set: row })
        .run();
      return;
    }
    case "factory.owner_check.updated": {
      const { check } = e.payload;
      const row = {
        id: check.id,
        projectId: check.projectId,
        check,
        createdAt: check.createdAt,
        removedAt: check.removedAt,
      };
      tx.insert(factoryOwnerChecks)
        .values(row)
        .onConflictDoUpdate({ target: factoryOwnerChecks.id, set: row })
        .run();
      return;
    }
    case "factory.owner_check_run.updated": {
      const { run } = e.payload;
      const row = {
        id: run.id,
        projectId: run.projectId,
        itemId: run.itemId,
        sessionId: run.sessionId,
        run,
        startedAt: run.startedAt,
      };
      tx.insert(factoryOwnerCheckRuns)
        .values(row)
        .onConflictDoUpdate({ target: factoryOwnerCheckRuns.id, set: row })
        .run();
      return;
    }
  }
}
