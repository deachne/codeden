import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AutomationSpend } from "@/components/usage/automation-spend";
import { mockReport } from "@/components/usage/mock-data";
import { renderWithClient } from "./utils";

describe("reports: automations whose work could not be priced", () => {
  it("does not show $0.00 for an automation with only unpriced turns", () => {
    const report = mockReport({ from: "2026-11-01", to: "2026-11-07" });
    report.automations.byAutomation = [
      {
        automationId: "a",
        name: "Nightly",
        costUsd: 0,
        estimatedCostUsd: 0,
        unpricedTurns: 3,
        sessions: 2,
      },
    ];
    renderWithClient(<AutomationSpend report={report} />);
    const row = screen.getByText("Nightly").closest("li");
    expect(row?.textContent).not.toContain("$0.00");
    expect(row?.textContent).toMatch(/unknown|could not price/i);
  });
});

describe("costFigureText", () => {
  const base = { costUsd: 0, estimatedCostUsd: 0, unpricedTurns: 0 };
  it("labels unknown, partly priced and priced costs", async () => {
    const { costFigureText } = await import("@/components/usage/format");
    expect(costFigureText({ ...base, unpricedTurns: 3 })).toBe("Cost unknown (3 turns unpriced)");
    expect(costFigureText({ ...base, costUsd: 1.2, unpricedTurns: 1 })).toBe(
      "≈ $1.20 + 1 turn unpriced",
    );
    expect(costFigureText({ ...base, costUsd: 1.2, estimatedCostUsd: 0.5 })).toBe("≈ $1.20");
    expect(costFigureText({ ...base, costUsd: 1.2 })).toBe("$1.20");
    expect(costFigureText(base)).toBe("$0.00");
  });
});
