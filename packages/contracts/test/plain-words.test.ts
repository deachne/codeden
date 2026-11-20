import { describe, expect, it } from "vitest";
import {
  GithubPr,
  PLAIN_WORDS_MAX,
  Project,
  plainWordsSection,
  UpdateProjectRequest,
} from "../src";
import { sampleProject } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

const SECTION = [
  "**What changed for you:** The inbox shows a short note first.",
  "",
  "**How to try it:** Open the inbox.",
  "",
  "**What wasn't checked:** Phones.",
  "",
  "**How to undo it:** Switch the setting off.",
].join("\n");

// #1: "Explain changes in plain words", a per-project setting, off by default.
describe("Project.plainWords", () => {
  it("is off by default, so projects written before it existed parse unchanged", () => {
    const { plainWords: _p, ...rest } = sampleProject;
    expect(Project.parse(rest).plainWords).toBe(false);
  });

  it("round-trips a project that turned it on, and through the update request", () => {
    expect(roundTrip(Project, { ...sampleProject, plainWords: true }).plainWords).toBe(true);
    expect(Project.safeParse({ ...sampleProject, plainWords: "yes" }).success).toBe(false);
    expect(roundTrip(UpdateProjectRequest, { plainWords: true })).toEqual({ plainWords: true });
  });
});

describe("plainWordsSection", () => {
  it("reads the section up to the next heading", () => {
    const body = `## In plain words\n\n${SECTION}\n\n## Summary\nTechnical detail.`;
    expect(plainWordsSection(body)).toBe(SECTION);
  });

  it("reads it at the end of the description, without CodeDen's footer or Fixes line", () => {
    const body = `## Summary\nx\n\n## In plain words\n${SECTION}\n\nFixes #1\n\n---\n<sub>Opened by CodeDen session</sub>\n<!-- codeden:session=s1 -->`;
    expect(plainWordsSection(body)).toBe(SECTION);
  });

  it("accepts any case, extra spaces and a colon, and keeps sub-headings and fenced lines", () => {
    const inner = "### What changed for you\nA note.\n```\n## not a heading\n```";
    expect(plainWordsSection(`##   in Plain Words:\r\n${inner}\r\n# Next`)).toBe(inner);
  });

  it("is null when the description has none, or it is empty", () => {
    expect(plainWordsSection(null)).toBeNull();
    expect(plainWordsSection("")).toBeNull();
    expect(plainWordsSection("## Summary\nIn plain words, nothing.")).toBeNull();
    expect(plainWordsSection("## In plain words\n\n## Summary\nx")).toBeNull();
  });

  it("cuts a very long section", () => {
    const long = plainWordsSection(`## In plain words\n${"a".repeat(PLAIN_WORDS_MAX + 50)}`);
    expect(long?.length).toBe(PLAIN_WORDS_MAX + 1);
    expect(long?.endsWith("…")).toBe(true);
  });
});

describe("GithubPr.plainWords", () => {
  const pr = {
    id: "p1:4",
    projectId: "p1",
    number: 4,
    title: "Fix bug",
    state: "open",
    url: "https://github.com/acme/widgets/pull/4",
    author: "octo",
    headBranch: "codeden/fix",
    baseBranch: "main",
    headSha: "abc",
    checks: { state: "success", total: 0, passed: 0, failed: 0, pending: 0, checks: [] },
    reviewDecision: "none",
    reviews: [],
    mergeable: "mergeable",
    linkedIssues: [],
    commits: [],
    sessionId: null,
    createdAt: null,
    updatedAt: "2026-11-07T10:00:00.000Z",
    mergedAt: null,
    closedAt: null,
  };

  it("round-trips the section and null, and reads rows synced before it was tracked", () => {
    expect(roundTrip(GithubPr, { ...pr, plainWords: SECTION }).plainWords).toBe(SECTION);
    expect(roundTrip(GithubPr, { ...pr, plainWords: null }).plainWords).toBeNull();
    expect(GithubPr.parse(pr).plainWords).toBeUndefined();
  });
});
