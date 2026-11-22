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

  it("shows a plain empty message, never green, for an empty batch", async () => {
    for (const ci of [null, "success"]) {
      const { unmount } = show({ ci, batch: [] });
      const text = (await screen.findByTestId("release-gates")).textContent ?? "";
      expect(text).toMatch(/Nothing waiting/);
      expect(text).not.toMatch(/green/i);
      unmount();
    }
  });

  it("shows the block reason once, instead of green, while CI fails or runs", async () => {
    for (const ci of ["failure", "pending"]) {
      const { unmount } = show({ ci, batch: [item], blockReason: `Blocked by ${ci}` });
      const text = (await screen.findByTestId("release-gates")).textContent ?? "";
      expect(text).not.toMatch(/green/i);
      expect(document.body.textContent?.split(`Blocked by ${ci}`).length).toBe(2);
      unmount();
    }
  });

  it("lets a block reason win over green CI (e.g. red default branch)", async () => {
    show({ ci: "success", batch: [item], blockReason: "Default branch CI is red" });
    const text = (await screen.findByTestId("release-gates")).textContent ?? "";
    expect(text).toMatch(/Default branch CI is red/);
    expect(text).not.toMatch(/green/i);
    expect(document.body.textContent?.split("Default branch CI is red").length).toBe(2);
  });

  it("says CI is green, and offers the release, when ready", async () => {
    show({ ci: "success", batch: [item], canRelease: true });
    expect((await screen.findByTestId("release-gates")).textContent).toMatch(/CI is green/);
    expect(screen.getByTestId("release-approve")).toBeTruthy();
  });

  it("also says the owner checks passed when they did", async () => {
    show({
      ci: "success",
      batch: [item],
      canRelease: true,
      ownerChecks: { state: "pass", count: 2, failed: [] },
    });
    const text = (await screen.findByTestId("release-gates")).textContent ?? "";
    expect(text).toMatch(/CI is green.*owner checks passed/);
    expect(screen.getByTestId("release-approve")).toBeTruthy();
  });
});
