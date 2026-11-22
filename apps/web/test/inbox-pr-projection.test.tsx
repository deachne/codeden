import type { InboxItem } from "@codeden/contracts";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InboxPlainWords } from "@/components/factory/plain-words";
import { PrReviewStatus } from "@/components/inbox/inbox-actions";
import { createMockClient } from "@/lib/api/mock";
import { mockPrs } from "@/lib/api/mock/fixtures/github";
import { renderWithClient } from "./utils";

/** Inbox cards read the synced PR projection, never GitHub live per card (#82). */
describe("inbox PR cards", () => {
  it("don't call the live per-PR endpoint", async () => {
    const pr = mockPrs[0] as (typeof mockPrs)[number];
    const base = createMockClient();
    const live = vi.fn(base.github.pr);
    const client = {
      ...base,
      github: {
        ...base.github,
        pr: live,
        prs: async (projectId: string, state?: Parameters<typeof base.github.prs>[1]) => {
          const res = await base.github.prs(projectId, state);
          return {
            ...res,
            prs: res.prs.map((p) =>
              p.number === pr.number ? { ...p, plainWords: "Plain card text" } : p,
            ),
          };
        },
      },
    };
    const item = { projectId: pr.projectId, pr: { number: pr.number } } as unknown as InboxItem;
    renderWithClient(
      <>
        <InboxPlainWords projectId={pr.projectId} prNumber={pr.number} />
        <PrReviewStatus item={item} />
      </>,
      client,
    );
    expect(await screen.findByText("Plain card text")).toBeTruthy();
    await waitFor(() => expect(live).not.toHaveBeenCalled());
  });
});
