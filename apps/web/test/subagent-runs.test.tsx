import type { Item, ItemOf, Session, SubagentCost } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockUsageApi } from "@/components/usage/mock-data";
import { DetailsPanel } from "@/components/workbench/details-panel";
import { subagentRunsHeadline } from "@/components/workbench/subagent-runs";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { subagentRuns } from "@/lib/subagent-runs";
import { emptyTranscript, type TranscriptState } from "@/lib/transcript/reducer";
import { useLayoutStore } from "@/stores/layout";
import { useTranscriptsStore } from "@/stores/transcripts";
import { renderWithClient } from "./utils";

const ID = "s-subagents";

function subagent(
  id: string,
  childThreadId: string,
  over: Partial<ItemOf<"subagent">> = {},
): ItemOf<"subagent"> {
  return { id, kind: "subagent", status: "completed", childThreadId, description: id, ...over };
}

/** A transcript from threads given as `[id, parentThreadId, items]`, the first being the root. */
function transcript(threads: [string, string | null, Item[]][], earlierTurns = 0): TranscriptState {
  const t = emptyTranscript(ID);
  t.rootThreadId = threads[0]?.[0] ?? null;
  t.earlierTurns = earlierTurns;
  for (const [id, parent, items] of threads) {
    t.threads[id] = {
      id,
      parentThreadId: parent,
      parentItemId: null,
      title: null,
      agentType: null,
      itemIds: items.map((i) => i.id),
      turnIds: [],
    };
    for (const item of items) t.items[item.id] = { item, turnId: "t1", threadId: id };
  }
  return t;
}

function cost(
  itemId: string,
  costUsd: number,
  costSource: SubagentCost["costSource"] = "reported",
): SubagentCost {
  return { itemId, costUsd, costSource, models: [] };
}

const text = (id: string): Item => ({
  id,
  kind: "assistant_message",
  status: "completed",
  text: "hi",
});

describe("subagentRuns (§7.3: every run, display-only totals)", () => {
  it("lists runs in transcript order, each followed by the runs it started, one level deeper", () => {
    const t = transcript([
      ["root", null, [text("m1"), subagent("a", "ta"), subagent("b", "tb")]],
      ["tb", "root", [subagent("b1", "tb1")]],
      ["ta", "root", [text("m2"), subagent("a1", "ta1")]],
      ["ta1", "ta", [subagent("a1x", "ta1x")]],
    ]);
    const { runs } = subagentRuns(t, []);
    expect(runs.map((r) => [r.itemId, r.depth])).toEqual([
      ["a", 0],
      ["a1", 1],
      ["a1x", 2],
      ["b", 0],
      ["b1", 1],
    ]);
  });

  it("matches costs by item id and sums priced runs, marking an estimate", () => {
    const t = transcript([
      [
        "root",
        null,
        [
          subagent("a", "ta", { stats: { totalTokens: 1_000 } }),
          subagent("b", "tb", { stats: { totalTokens: 500 } }),
          subagent("c", "tc"),
          subagent("d", "td", { status: "in_progress" }),
        ],
      ],
    ]);
    const s = subagentRuns(t, [
      cost("a", 0.1),
      cost("b", 0.05, "estimated"),
      cost("c", 0, "unpriced"),
    ]);
    expect(s.runs.find((r) => r.itemId === "b")?.cost?.costUsd).toBe(0.05);
    expect(s.costUsd).toBeCloseTo(0.15);
    expect(s.estimated).toBe(true);
    expect(s.totalTokens).toBe(1_500);
    expect(s.unpriced).toBe(1);
    expect(s.running).toBe(1);
    expect(s.notLoaded).toEqual({ runs: 0, costUsd: 0 });
    expect(subagentRunsHeadline(s)).toBe("4 runs · ≈ $0.15 · 2k tokens · 1 running");
  });

  it("counts priced runs in turns not loaded here, so totals aren't silently short", () => {
    const t = transcript([["root", null, [subagent("a", "ta")]]], 5);
    const s = subagentRuns(t, [
      cost("a", 0.2),
      cost("old1", 0.3),
      cost("old2", 0.5),
      cost("old3", 0, "unpriced"),
    ]);
    expect(s.runs).toHaveLength(1);
    expect(s.costUsd).toBeCloseTo(0.2);
    expect(s.notLoaded.runs).toBe(2);
    expect(s.notLoaded.costUsd).toBeCloseTo(0.8);
    expect(subagentRunsHeadline(s)).toBe("3 runs · $1.00");
  });

  it("shows no cost for runs nothing could price", () => {
    const t = transcript([["root", null, [subagent("a", "ta")]]]);
    expect(subagentRunsHeadline(subagentRuns(t, [cost("a", 0, "unpriced")]))).toBe("1 run");
  });

  it("is empty without a transcript", () => {
    expect(subagentRuns(undefined, []).runs).toEqual([]);
  });
});

describe("Session details › Subagent runs", () => {
  const session = (): Session =>
    makeSession({
      id: ID,
      projectId: "p-storefront",
      role: "agent",
      status: "idle",
      provider: "claude",
      purpose: "Review the subagents",
      workKey: "issue:8",
    });

  function usage(subagents: SubagentCost[]) {
    vi.spyOn(mockUsageApi, "session").mockResolvedValue({
      sessionId: ID,
      billing: "api",
      turns: [],
      subagents,
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        estimatedCostUsd: 0,
        unpricedTurns: 0,
        turns: 0,
        sessions: 1,
        cacheHitRate: null,
      },
    });
  }

  afterEach(() => {
    useTranscriptsStore.setState({ byId: {} });
    vi.restoreAllMocks();
  });

  it("lists each run with its figures and opens its thread on click", async () => {
    const t = transcript([
      [
        "root",
        null,
        [
          subagent("a", "ta", {
            description: "Review the diff",
            agentType: "code-reviewer",
            stats: { totalTokens: 48_000, durationMs: 72_000 },
          }),
          subagent("b", "tb", { status: "failed", description: "Run the tests" }),
        ],
      ],
    ]);
    useTranscriptsStore.setState({ byId: { [ID]: t } });
    usage([cost("a", 0.42)]);
    const openChild = vi.spyOn(useLayoutStore.getState(), "openChildThread");
    useLayoutStore.setState({ openChildThread: openChild });
    renderWithClient(<DetailsPanel session={session()} />, undefined, { withRouter: true });

    const headline = await screen.findByTestId("subagent-runs-headline");
    await waitFor(() => expect(headline.textContent).toBe("2 runs · $0.42 · 48k tokens"));
    const rows = screen.getAllByTestId("subagent-run");
    expect(rows[0]?.textContent).toContain("Review the diff");
    expect(rows[0]?.textContent).toContain("code-reviewer");
    expect(rows[0]?.textContent).toContain("$0.42 · 48k tokens · 1m 12s");
    expect(rows[1]?.textContent).toContain("Failed");
    fireEvent.click(rows[0] as HTMLElement);
    expect(openChild).toHaveBeenCalledWith(ID, "ta");
  });

  it("is absent for a session without subagent runs", async () => {
    useTranscriptsStore.setState({ byId: { [ID]: transcript([["root", null, [text("m1")]]]) } });
    usage([]);
    renderWithClient(<DetailsPanel session={session()} />, undefined, { withRouter: true });
    await screen.findByText("Context window");
    expect(screen.queryByTestId("subagent-runs")).toBeNull();
  });
});
