import { describe, expect, it } from "vitest";
import { filterForEvent, filtersFor } from "../src/components/automations/trigger-editor";

describe("trigger filters", () => {
  it("offers labels on issue events only", () => {
    expect(filtersFor("issue.labeled")).toContain("labels");
    expect(filtersFor("pr.merged")).toEqual(["branches", "authors"]);
  });

  it("drops the labels filter when switching from an issue to a PR event", () => {
    expect(filterForEvent("pr.opened", { labels: ["bug"], authors: ["lee"] })).toEqual({
      authors: ["lee"],
    });
    expect(filterForEvent("pr.opened", { labels: ["bug"] })).toBeUndefined();
  });
});
