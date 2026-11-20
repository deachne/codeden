import { PLAIN_WORDS_PARTS } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { agentPrompt, type PromptSession } from "../src/mcp/prompt";
import {
  builderPrompt,
  fixStep,
  implementStep,
  NO_LESSONS,
  reviewerPrompt,
} from "../src/services/factory/prompts";
import type { GqlPullRequest } from "../src/services/github/graphql";

/**
 * #1: "Explain changes in plain words" (`Project.plainWords`). With it on, builders (factory and
 * ordinary sessions) start PR descriptions with a `## In plain words` section in four parts, and
 * the reviewer notes a missing one as a follow-up, never blocking. With it off nothing changes.
 */
const item = (over: Record<string, unknown> = {}) =>
  ({
    id: "i1",
    source: "issue",
    area: null,
    type: "bug",
    title: "Crash on save",
    summary: "Saving an empty task crashes.",
    acceptanceCriteria: ["Saving an empty task works"],
    issue: { number: 7, url: "https://github.com/acme/app/issues/7", title: "Crash on save" },
    investigation: null,
    pr: { number: 9, url: "https://github.com/acme/app/pull/9", state: "open" },
    ...over,
  }) as never;

const reproduced = item({
  investigation: { kind: "reproduction", outcome: "reproduced", summary: "s", details: "d" },
});
const analyzed = item({
  type: "feature",
  investigation: { kind: "analysis", outcome: "implement", summary: "s", details: "spec" },
});

const ON = { ...NO_LESSONS, plainWords: true };

function asksForSection(text: string): void {
  expect(text).toContain("`## In plain words`");
  for (const part of PLAIN_WORDS_PARTS) expect(text).toContain(`**${part}**`);
  expect(text).toMatch(/No code, file names, commands or jargon/);
}

describe("builders' briefs", () => {
  const cases = {
    "bug fix": reproduced,
    "feature implement": analyzed,
    docs: item({ type: "docs" }),
  };

  for (const [name, it_] of Object.entries(cases)) {
    it(`${name}: asks for the section when on, and is unchanged when off`, () => {
      const off = builderPrompt(it_, "v");
      expect(off).not.toContain("In plain words");
      expect(builderPrompt(it_, "v", { ...NO_LESSONS, plainWords: false })).toBe(off);
      asksForSection(builderPrompt(it_, "v", ON));
    });
  }

  it("the next step after a report carries it too", () => {
    expect(fixStep(reproduced)).not.toContain("In plain words");
    asksForSection(fixStep(reproduced, true));
    expect(implementStep(analyzed)).not.toContain("In plain words");
    asksForSection(implementStep(analyzed, true));
  });

  it("steps that open no pull request don't ask for it", () => {
    expect(builderPrompt(item(), "v", ON)).not.toContain("In plain words");
    expect(builderPrompt(item({ type: "feature" }), "v", ON)).not.toContain("In plain words");
  });
});

describe("the reviewer's brief", () => {
  const off = reviewerPrompt(item(), "v", null, "main", false);

  it("is unchanged with the setting off", () => {
    expect(off).not.toContain("In plain words");
    expect(reviewerPrompt(item(), "v", null, "main", false, NO_LESSONS, null)).toBe(off);
  });

  it("asks for a follow-up when the section is missing, never a block", () => {
    const text = reviewerPrompt(item(), "v", null, "main", false, NO_LESSONS, "missing");
    expect(text).toContain('add a follow-up "Explain this change in plain words"');
    expect(text).toContain("It never blocks the merge: don't request changes or reject for it.");
  });

  it("checks a section that is there for jargon, as a follow-up", () => {
    const text = reviewerPrompt(item(), "v", null, "main", false, NO_LESSONS, "present");
    expect(text).toMatch(/jargon in it, add a follow-up/);
    expect(text).toContain("It never blocks the merge");
  });
});

describe("ordinary sessions' system prompt", () => {
  const session: PromptSession = {
    role: "agent",
    startedBy: { kind: "user" },
    worktreePath: "/wt/app/s1",
    autonomy: "auto",
  };

  it("asks for the section in GitHub projects with it on", () => {
    asksForSection(agentPrompt(session, { kind: "github", plainWords: true }));
    asksForSection(
      agentPrompt(
        { ...session, startedBy: { kind: "pm", id: "pm" } },
        {
          kind: "github",
          plainWords: true,
        },
      ),
    );
  });

  it("is unchanged with it off, and in projects without pull requests", () => {
    const off = agentPrompt(session, { kind: "github" });
    expect(off).not.toContain("In plain words");
    expect(agentPrompt(session, { kind: "github", plainWords: false })).toBe(off);
    expect(agentPrompt(session, { kind: "local", plainWords: true })).not.toContain(
      "In plain words",
    );
  });
});

describe("the PR sync", () => {
  it("keeps the description's plain-words section on the projection, null without one", async () => {
    const { toGithubPr } = await import("../src/services/github/graphql");
    const node: GqlPullRequest = {
      number: 4,
      title: "t",
      url: "https://github.com/acme/app/pull/4",
      state: "OPEN",
      isDraft: false,
      merged: false,
      mergedAt: null,
      closedAt: null,
      createdAt: "2026-11-20T10:00:00Z",
      updatedAt: "2026-11-20T10:00:00Z",
      body: "## In plain words\n**What changed for you:** A note.\n\n## Summary\nx\n\nFixes #7",
      headRefName: "codeden/x",
      baseRefName: "main",
      headRefOid: "abc",
      mergeable: "MERGEABLE",
      reviewDecision: null,
      author: null,
      closingIssuesReferences: null,
      commits: { nodes: [] },
      head: { nodes: [] },
      reviews: { nodes: [] },
    };
    expect(toGithubPr("p1", node, null).plainWords).toBe("**What changed for you:** A note.");
    expect(toGithubPr("p1", { ...node, body: "Fixes #7" }, null).plainWords).toBeNull();
  });
});
