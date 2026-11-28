import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlanReviewPanel } from "@/components/project/plan-review/plan-review-panel";
import { SecondOpinionsButton } from "@/components/project/plan-review/second-opinions-button";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

/** §8.5: Get second opinions is a button; nothing starts before Go; the table is answered row by row. */

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

describe("Get second opinions", () => {
  it("shows who reviews and a rough cost, and starts nothing until Go", async () => {
    const client = createMockClient();
    const start = vi.spyOn(client.planReviews, "start");
    renderWithClient(<SecondOpinionsButton projectId="p1" />, client);

    fireEvent.click(screen.getByRole("button", { name: /Get second opinions/ }));
    const box = await screen.findByTestId("second-opinions-box");
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3));
    for (const box of screen.getAllByRole("checkbox"))
      expect((box as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("second-opinions-cost").textContent).toContain("about $4.50");
    expect(box.textContent).toContain("Nothing starts until you press Go");
    expect(start).not.toHaveBeenCalled();

    // Unticking a reviewer lowers the estimate; Go starts only the ticked ones.
    fireEvent.click(screen.getAllByRole("checkbox")[2] as HTMLElement);
    expect(screen.getByTestId("second-opinions-cost").textContent).toContain("about $3.50");
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledWith("p1", { reviewers: ["codex", "gemini"], capUsd: 3 });
  });
});

describe("the table", () => {
  it("lets the owner accept or reject each row and send the accepted ones", async () => {
    const client = createMockClient();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await client.planReviews.start("p1", { reviewers: ["codex"], capUsd: 3 });
      const { queryClient } = renderWithClient(<PlanReviewPanel projectId="p1" />, client);
      await screen.findByText(/Waiting for the reviewers/);
      await vi.advanceTimersByTimeAsync(3200);
      // In the app a `project.plan_review.updated` event does this.
      await queryClient.invalidateQueries({ queryKey: ["factory", "plan-review"] });
      await screen.findByText(/A hosting plan is missing/);
      // A row only the owner can settle is marked.
      expect(screen.getByText(/Needs your decision/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
    const apply = screen.getByRole("button", { name: /Add accepted to plan/ }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    const accept = screen.getAllByRole("button", { name: "Accept" })[0] as HTMLElement;
    fireEvent.click(accept);
    await waitFor(() => expect(accept.getAttribute("aria-pressed")).toBe("true"));
    await waitFor(() => expect(apply.disabled).toBe(false));
    fireEvent.click(apply);
    await screen.findByText(/Sent to the Planner/);
  });
});
