import { FactoryReleaseSnapshot } from "@codeden/contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReleaseCard } from "@/components/factory/release-card";
import { renderWithClient } from "./utils";

/** The release card's gate line must match the real batch, CI and block reason (#72). */

const snap = (patch: Partial<FactoryReleaseSnapshot> = {}) =>
  FactoryReleaseSnapshot.parse({ branch: "release", ...patch });

const gates = async (release: FactoryReleaseSnapshot) => {
  renderWithClient(<ReleaseCard projectId="p1" release={release} />, undefined, {
    withRouter: true,
  });
  return (await screen.findByTestId("release-gates")).textContent ?? "";
};

describe("release card gate line", () => {
  it("does not claim CI is green for an empty batch with unknown CI", async () => {
    expect(await gates(snap({ blockReason: "Couldn't read the release branch" }))).not.toMatch(
      /CI is green/,
    );
  });

  it("does not claim CI is green when CI is failing", async () => {
    expect(await gates(snap({ ci: "failure", blockReason: "CI failed" }))).not.toMatch(
      /CI is green/,
    );
  });

  it("does not claim CI is green when CI is still running", async () => {
    expect(await gates(snap({ ci: "pending", blockReason: "CI running" }))).not.toMatch(
      /CI is green/,
    );
  });

  it("shows the block reason when the batch is empty", async () => {
    await gates(snap({ blockReason: "Couldn't read the release branch" }));
    expect(screen.getAllByText(/Couldn't read the release branch/).length).toBeGreaterThan(0);
  });
});
