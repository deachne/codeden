import {
  BUILDER_SCORE_MIN_CHANGES,
  type BuilderScore,
  type BuilderScoreRow,
  type FactoryItem,
  type FactoryItemCost,
  type FactoryItemStage,
  type ScorecardDays,
} from "@codeden/contracts";
import type { FactoryContext } from "./context";
import { itemCosts } from "./item-cost";
import { scorecardOutcome } from "./scorecard";
import { revertedAt } from "./stats";

/**
 * The builder score (§12.6, §10.1): how each builder model, by provider and model, did on the
 * factory's real work in a window, across every project or one. It counts what the scorecard
 * counts (`scorecardOutcome`), grouped by the builder alone, and adds the work still in flight
 * so it reads as "in progress", never as a failure. Read on demand; nothing is stored.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** Stages where a builder's change hasn't reached a result yet. */
const IN_FLIGHT: ReadonlySet<FactoryItemStage> = new Set([
  "candidate",
  "backlog",
  "building",
  "verifying",
  "watching",
]);

/** What the score needs besides the items. */
export interface BuilderScoreFacts {
  /** The model each builder session ran (null: the provider's default), by session id. */
  models: ReadonlyMap<string, string | null>;
  /** What each finished item cost, by item id (`itemCosts`). */
  costs: ReadonlyMap<string, FactoryItemCost>;
}

interface Tally extends Omit<BuilderScoreRow, "costUsd" | "estimatedUsd" | "costPerMergeUsd"> {
  costUsd: number;
  estimatedUsd: number;
}

/** An item still in flight with a builder, and not one of the factory's own reverts. */
export function inFlightWithBuilder(item: FactoryItem): boolean {
  return item.source !== "revert" && !!item.builderProvider && IN_FLIGHT.has(item.stage);
}

function tallyFor(rows: Map<string, Tally>, item: FactoryItem, facts: BuilderScoreFacts): Tally {
  const provider = item.builderProvider as string;
  const model = (item.builderSessionId ? facts.models.get(item.builderSessionId) : null) ?? null;
  const key = JSON.stringify([provider, model]);
  let row = rows.get(key);
  if (!row) {
    row = {
      key,
      provider,
      model,
      finished: 0,
      merged: 0,
      failed: 0,
      firstPass: 0,
      reviseRounds: 0,
      reverted: 0,
      inProgress: 0,
      costUsd: 0,
      estimatedUsd: 0,
      unpricedTurns: 0,
      apiEquivalent: false,
      tooFew: true,
    };
    rows.set(key, row);
  }
  return row;
}

function toRow(t: Tally): BuilderScoreRow {
  return {
    ...t,
    costUsd: round(t.costUsd),
    estimatedUsd: round(t.estimatedUsd),
    costPerMergeUsd: t.merged > 0 ? round(t.costUsd / t.merged) : null,
    tooFew: t.finished < BUILDER_SCORE_MIN_CHANGES,
  };
}

/** Most finished changes first, then in progress, then by key (code units) so the order is stable. */
function sorted(rows: Map<string, Tally>): BuilderScoreRow[] {
  const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...rows.values()]
    .map(toRow)
    .sort((a, b) => b.finished - a.finished || b.inProgress - a.inProgress || byKey(a.key, b.key));
}

/**
 * The score over `items` (any project, any stage) for the `days` before `now`. Each item counts
 * for the builder of its last attempt, with that session's model.
 */
export function builderScore(
  items: FactoryItem[],
  facts: BuilderScoreFacts,
  now: Date,
  days: ScorecardDays,
): BuilderScore {
  const end = now.getTime();
  const since = end - days * DAY_MS;
  const rows = new Map<string, Tally>();
  let finished = 0;
  let inProgress = 0;
  for (const item of items) {
    const outcome = scorecardOutcome(item, since, end);
    if (!outcome) {
      if (inFlightWithBuilder(item)) {
        tallyFor(rows, item, facts).inProgress++;
        inProgress++;
      }
      continue;
    }
    finished++;
    const row = tallyFor(rows, item, facts);
    row.finished++;
    row.reviseRounds += item.attempts;
    if (outcome === "merged") {
      const reverted = revertedAt(item) !== null;
      row.merged++;
      // A merge reverted before its revise round (older items, `stage: reverted`) wasn't a pass.
      if (item.attempts === 0 && !reverted) row.firstPass++;
      if (reverted) row.reverted++;
    } else {
      row.failed++;
    }
    const cost = facts.costs.get(item.id);
    if (cost) {
      row.costUsd += cost.usd;
      row.estimatedUsd += cost.estimatedUsd;
      row.unpricedTurns += cost.unpricedTurns;
      row.apiEquivalent ||= cost.apiEquivalent;
    }
  }
  return {
    days,
    since: new Date(since).toISOString(),
    minChanges: BUILDER_SCORE_MIN_CHANGES,
    finished,
    inProgress,
    rows: sorted(rows),
  };
}

/**
 * `GET /api/usage/builders`: the items of every active project (or `projectId`'s), the models of
 * their builder sessions (looked up by id, archived or not) and what the finished items cost,
 * one ledger read per project.
 */
export async function buildBuilderScore(
  ctx: Pick<FactoryContext, "projects" | "now" | "store" | "repo" | "usage" | "sessions">,
  days: ScorecardDays,
  projectId?: string,
): Promise<BuilderScore> {
  const now = ctx.now();
  const end = now.getTime();
  const since = end - days * DAY_MS;
  const projects = projectId ? [ctx.projects.get(projectId)] : ctx.projects.list();
  const items: FactoryItem[] = [];
  const costs = new Map<string, FactoryItemCost>();
  for (const project of projects) {
    const all = ctx.store.items(project.id);
    const relevant = all.filter(
      (i) => scorecardOutcome(i, since, end) !== null || inFlightWithBuilder(i),
    );
    const finished = relevant.filter((i) => scorecardOutcome(i, since, end) !== null);
    for (const [id, cost] of await itemCosts(ctx, project.id, project.factoryLimits, finished)) {
      costs.set(id, cost);
    }
    items.push(...relevant);
  }
  const models = ctx.repo.modelsOf(
    items.map((i) => i.builderSessionId).filter((id): id is string => id !== null),
  );
  return builderScore(items, { models, costs }, now, days);
}
