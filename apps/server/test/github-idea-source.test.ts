import { describe, expect, it } from "vitest";
import { ideaSourceOf } from "../src/services/github/idea-source";

describe("ideaSourceOf", () => {
  it("reads the Idea source line in either form", () => {
    expect(ideaSourceOf("Plan\n\nIdea source: deachne/ideas#53\n", "deachne/ideas")).toEqual({
      owner: "deachne",
      repo: "ideas",
      number: 53,
    });
    expect(
      ideaSourceOf("idea source: https://github.com/Deachne/Ideas/issues/7", "deachne/ideas"),
    ).toMatchObject({ number: 7 });
  });

  it("ignores other repositories and bodies without the line", () => {
    expect(ideaSourceOf("Idea source: someone/else#3", "deachne/ideas")).toBeNull();
    expect(ideaSourceOf("Fixes deachne/ideas#3", "deachne/ideas")).toBeNull();
    expect(ideaSourceOf("Idea source: deachne/ideas-old#3", "deachne/ideas")).toBeNull();
  });
});
