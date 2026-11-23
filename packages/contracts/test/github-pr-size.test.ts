import { describe, expect, it } from "vitest";
import { GithubPr } from "../src/github";

const base = {
  id: "p:1",
  projectId: "p",
  number: 1,
  title: "t",
  state: "open",
  url: "https://example.test/1",
  author: null,
  headBranch: "h",
  baseBranch: "main",
  headSha: null,
  checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0, checks: [] },
  reviewDecision: "none",
  reviews: [],
  mergeable: "unknown",
  linkedIssues: [],
  commits: [],
  sessionId: null,
  createdAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  mergedAt: null,
  closedAt: null,
};

describe("GithubPr diff size", () => {
  it("round-trips the counts and still parses rows without them", () => {
    const sized = GithubPr.parse({ ...base, additions: 3, deletions: 2, changedFiles: 1 });
    expect(GithubPr.parse(JSON.parse(JSON.stringify(sized)))).toEqual(sized);
    expect(GithubPr.parse(base).additions).toBeUndefined();
    expect(GithubPr.parse({ ...base, additions: null }).additions).toBeNull();
  });
});
