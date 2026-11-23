import type { GithubPr, InboxItem } from "@codeden/contracts";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InboxPlainWords } from "@/components/factory/plain-words";
import { PrReviewStatus } from "@/components/inbox/inbox-actions";
import { createMockClient } from "@/lib/api/mock";
import { checks, mockPrs } from "@/lib/api/mock/fixtures/github";
import { renderWithClient } from "./utils";

/** Inbox cards read the synced PR projection, never GitHub live per card (#82). */
describe("inbox PR cards", () => {
  it("share one synced PR query and never call the live per-PR endpoint", async () => {
    const [first, second] = mockPrs as [(typeof mockPrs)[number], (typeof mockPrs)[number]];
    const projectId = first.projectId;
    const base = createMockClient();
    const synced: GithubPr[] = [
      {
        ...first,
        plainWords: "First card text",
        additions: 120,
        deletions: 7,
        changedFiles: 1,
        checks: checks([["ci", "success"]]),
        mergeable: "mergeable",
      },
      {
        ...second,
        projectId,
        plainWords: "Second card text",
        additions: null,
        deletions: null,
        changedFiles: null,
        checks: checks([["ci", "failure"]]),
        mergeable: "conflicting",
      },
    ];
    const live = vi.fn(base.github.pr);
    const prs = vi.fn(async () => ({
      connection: (await base.github.prs(projectId)).connection,
      sync: null,
      prs: synced,
    }));
    const client = { ...base, github: { ...base.github, pr: live, prs } };
    const card = (pr: GithubPr) => {
      const item = { projectId, pr: { number: pr.number } } as unknown as InboxItem;
      return (
        <div key={pr.number} data-testid={`card-${pr.number}`}>
          <InboxPlainWords projectId={projectId} prNumber={pr.number} />
          <PrReviewStatus item={item} />
        </div>
      );
    };
    renderWithClient(<div>{synced.map(card)}</div>, client);

    expect(await screen.findByText("First card text")).toBeTruthy();
    expect(await screen.findByText("Second card text")).toBeTruthy();
    // Each card's status comes from its own synced row.
    await waitFor(() => {
      const a = screen.getByTestId(`card-${first.number}`);
      const b = screen.getByTestId(`card-${second.number}`);
      expect(a.querySelector("[data-checks='success']")).not.toBeNull();
      expect(a.textContent).not.toContain("Merge conflicts");
      expect(a.querySelector("[data-testid='pr-size']")?.textContent).toBe("+120 −7 · 1 file");
      expect(b.querySelector("[data-testid='pr-size']")).toBeNull();
      expect(b.querySelector("[data-checks='failure']")).not.toBeNull();
      expect(b.textContent).toContain("Merge conflicts");
    });
    expect(prs).toHaveBeenCalledTimes(1);
    expect(prs).toHaveBeenCalledWith(projectId, "all");
    expect(live).not.toHaveBeenCalled();
  });
});
