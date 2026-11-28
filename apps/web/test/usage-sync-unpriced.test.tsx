import type { BuilderScoreRow } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AutomationSpend } from "@/components/usage/automation-spend";
import { costPerChangeTitle } from "@/components/usage/builder-score";
import { costFigureText } from "@/components/usage/format";
import { mockReport, mockUsageApi } from "@/components/usage/mock-data";
import { UnpricedNote } from "@/components/usage/totals";
import { ReportsPage } from "@/routes/reports";
import { renderWithClient } from "./utils";

/** The builder score follows the Usage filters, and unpriced work never reads as $0.00 (#206). */

const builderRow = (patch: Partial<BuilderScoreRow> = {}): BuilderScoreRow => ({
  key: "k",
  provider: "cursor",
  model: "composer-2.5",
  finished: 8,
  merged: 6,
  failed: 2,
  firstPass: 4,
  reviseRounds: 6,
  reverted: 1,
  inProgress: 0,
  costUsd: 12,
  costPerMergeUsd: 2,
  estimatedUsd: 0,
  unpricedTurns: 0,
  apiEquivalent: false,
  tooFew: false,
  ...patch,
});

describe("the builder score follows the project filter", () => {
  it("asks for every project once the starting project chip is removed", async () => {
    const builders = vi.spyOn(mockUsageApi, "builders");
    renderWithClient(<ReportsPage projectId="p1" />, undefined, { withRouter: true });
    await waitFor(() => expect(builders).toHaveBeenCalledWith(30, "p1"));
    fireEvent.click(await screen.findByRole("button", { name: /Remove filter Project/ }));
    await waitFor(() => expect(builders).toHaveBeenLastCalledWith(30, undefined));
    builders.mockRestore();
  });
});

describe("unpriced work is never $0.00", () => {
  it("shows Not priced in a spend tile whose turns all had no price", () => {
    const report = mockReport({ from: "2026-11-01", to: "2026-11-07" });
    report.automations = {
      ...report.automations,
      manualCostUsd: 0,
      automationCostUsd: 0,
      factoryCostUsd: 4,
      byAutomation: [],
      manualUnpricedTurns: 3,
      automationUnpricedTurns: 0,
      factoryUnpricedTurns: 0,
    };
    renderWithClient(<AutomationSpend report={report} />);
    const tile = screen.getByText("Interactive").closest("div")?.parentElement;
    expect(tile?.textContent).toContain("Not priced");
    expect(tile?.textContent).not.toContain("$0.00");
  });

  it("words a builder row with only unpriced turns as not priced in its tooltip", () => {
    const title = costPerChangeTitle(
      builderRow({ costUsd: 0, costPerMergeUsd: 0, unpricedTurns: 3 }),
    );
    expect(title).not.toContain("$0.00");
    expect(title).toContain("Not priced");
  });

  it("the unpriced note does not claim the cost is $0", () => {
    const report = mockReport({ from: "2026-11-01", to: "2026-11-07" });
    report.totals.unpricedTurns = 4;
    renderWithClient(<UnpricedNote report={report} />);
    expect(document.body.textContent).not.toContain("cost $0");
  });

  it("costFigureText says Not priced, and only estimates when something was estimated", () => {
    const base = { costUsd: 0, estimatedCostUsd: 0, unpricedTurns: 0 };
    expect(costFigureText({ ...base, unpricedTurns: 3 })).toBe("Not priced (3 turns)");
    expect(costFigureText({ ...base, costUsd: 1.2, unpricedTurns: 1 })).toBe(
      "$1.20 + 1 turn not priced",
    );
    expect(costFigureText({ ...base, costUsd: 1.2, estimatedCostUsd: 0.5, unpricedTurns: 1 })).toBe(
      "≈ $1.20 + 1 turn not priced",
    );
  });
});
