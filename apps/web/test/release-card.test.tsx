import { FactoryReleaseSnapshot } from "@codeden/contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReleaseCard } from "@/components/factory/release-card";
import { renderWithClient } from "./utils";

/** The release card's status line must follow the real batch, CI and block reason. */
const item = {
  itemId: "i-1",
  title: "Add export",
  prNumber: 5,
  url: "https://github.com/a/b/pull/5",
  mergedAt: "2026-11-14T08:00:00.000Z",
};
const show = (patch: Record<string, unknown>) =>
  renderWithClient(
    <ReleaseCard projectId="p" release={FactoryReleaseSnapshot.parse(patch)} />,
    undefined,
    { withRouter: true },
  );

describe("ReleaseCard status", () => {
  it("does not claim CI is green for an empty, unread branch", async () => {
    show({ blockReason: "Couldn't read the release branch" });
    const text = (await screen.findByTestId("release-gates")).textContent ?? "";
    expect(text).not.toMatch(/green/i);
    expect(document.body.textContent).toMatch(/Couldn't read the release branch/);
  });

  it("does not claim CI is green while CI fails or runs", async () => {
    for (const ci of ["failure", "pending"]) {
      const { unmount } = show({ ci, batch: [item], blockReason: `CI ${ci}` });
      const text = (await screen.findByTestId("release-gates")).textContent ?? "";
      expect(text).not.toMatch(/green/i);
      unmount();
    }
  });

  it("says CI is green when it is", async () => {
    show({ ci: "success", batch: [item], canRelease: true });
    expect((await screen.findByTestId("release-gates")).textContent).toMatch(/green/i);
  });
});
