import type { ItemOf, ItemStatus, SubagentCost, SubagentStats } from "@codeden/contracts";
import type { TranscriptState } from "@/lib/transcript/reducer";

/** One subagent run of a session, for Session details › Subagent runs (§7.3). */
export interface SubagentRun {
  itemId: string;
  childThreadId: string;
  description: string;
  agentType: string | null;
  status: ItemStatus;
  /** 0 for a run the session's own thread started, 1 for one a subagent started, and so on. */
  depth: number;
  stats: SubagentStats | undefined;
  /** What the run cost, as the server priced it (`SessionUsage.subagents`); display only. */
  cost: SubagentCost | undefined;
}

/** A session's subagent runs and what they add up to. Every figure is display only. */
export interface SubagentRunsSummary {
  runs: SubagentRun[];
  running: number;
  /** Summed cost of the loaded runs that could be priced. */
  costUsd: number;
  /** True when any part of `costUsd` (or `notLoaded.costUsd`) is an estimate. */
  estimated: boolean;
  /** Summed tokens the loaded runs reported (`stats.totalTokens`). */
  totalTokens: number;
  /** Finished loaded runs without a price (no cost, or no model could be priced). */
  unpriced: number;
  /** Priced runs in turns not loaded here (a long session opens at its latest turns). */
  notLoaded: { runs: number; costUsd: number };
}

const isPriced = (c: SubagentCost | undefined): c is SubagentCost =>
  c !== undefined && c.costSource !== "unpriced";

/**
 * Every subagent run in the loaded transcript, in the order the transcript shows them: the
 * session's own thread first, each run followed by the runs it started (one level deeper).
 * Runs whose parent thread isn't loaded come last. Costs come from `costs` by item id; priced
 * runs with no loaded item are counted in `notLoaded`, so the totals are never silently short.
 * Pure.
 */
export function subagentRuns(
  transcript: TranscriptState | undefined,
  costs: readonly SubagentCost[],
): SubagentRunsSummary {
  const costById = new Map(costs.map((c) => [c.itemId, c]));
  const runs: SubagentRun[] = [];
  const seen = new Set<string>();

  const add = (item: ItemOf<"subagent">, depth: number) => {
    seen.add(item.id);
    runs.push({
      itemId: item.id,
      childThreadId: item.childThreadId,
      description: item.description ?? "Subagent",
      agentType: item.agentType ?? null,
      status: item.status,
      depth,
      stats: item.stats,
      cost: costById.get(item.id),
    });
  };

  const walk = (threadId: string, depth: number, visited: Set<string>) => {
    const thread = transcript?.threads[threadId];
    if (!thread || visited.has(threadId)) return;
    visited.add(threadId);
    for (const id of thread.itemIds) {
      const item = transcript?.items[id]?.item;
      if (item?.kind !== "subagent" || seen.has(item.id)) continue;
      add(item, depth);
      walk(item.childThreadId, depth + 1, visited);
    }
  };

  if (transcript) {
    const visited = new Set<string>();
    if (transcript.rootThreadId) walk(transcript.rootThreadId, 0, visited);
    // Runs in threads the walk didn't reach (their parent isn't loaded).
    for (const entry of Object.values(transcript.items)) {
      const item = entry.item;
      if (item.kind !== "subagent" || seen.has(item.id)) continue;
      add(item, threadDepth(transcript, entry.threadId));
      walk(item.childThreadId, threadDepth(transcript, entry.threadId) + 1, visited);
    }
  }

  let costUsd = 0;
  let estimated = false;
  let totalTokens = 0;
  let unpriced = 0;
  let running = 0;
  for (const run of runs) {
    if (run.status === "in_progress") running += 1;
    totalTokens += run.stats?.totalTokens ?? 0;
    if (isPriced(run.cost)) {
      costUsd += run.cost.costUsd;
      if (run.cost.costSource === "estimated") estimated = true;
    } else if (run.status !== "in_progress") unpriced += 1;
  }

  const notLoaded = { runs: 0, costUsd: 0 };
  for (const cost of costs) {
    if (seen.has(cost.itemId) || !isPriced(cost)) continue;
    notLoaded.runs += 1;
    notLoaded.costUsd += cost.costUsd;
    if (cost.costSource === "estimated") estimated = true;
  }

  return { runs, running, costUsd, estimated, totalTokens, unpriced, notLoaded };
}

/** How many subagent levels down a thread is (0 for the session's own thread). */
function threadDepth(transcript: TranscriptState, threadId: string): number {
  let depth = 0;
  let thread = transcript.threads[threadId];
  const visited = new Set<string>();
  while (thread?.parentThreadId && !visited.has(thread.id)) {
    visited.add(thread.id);
    depth += 1;
    thread = transcript.threads[thread.parentThreadId];
  }
  return depth;
}
