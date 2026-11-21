import { describe, expect, it } from "vitest";
import {
  builderSafeObservation,
  EventEnvelope,
  FactoryTuning,
  MergeCheckName,
  OBSERVATION_WITHHELD,
  OwnerCheck,
  OwnerCheckRun,
  OwnerCheckRunRequest,
  OwnerChecksResponse,
  OwnerChecksSubmission,
  OwnerCheckWriteRequest,
} from "../src";
import { ts } from "./fixtures";

/** Owner checks (§10.1, issue #2): the owner's scenarios and the tryout runs that try them. */

const check: OwnerCheck = {
  id: "c1",
  projectId: "p1",
  text: "I paste a YouTube link and get a condensed version with timestamps",
  createdAt: ts,
  updatedAt: ts,
  removedAt: null,
  last: {
    state: "pass",
    observation: "A summary with times appeared.",
    screenshot: "art-1",
    prNumber: 12,
    sessionId: "s9",
    at: ts,
  },
};

const run: OwnerCheckRun = {
  id: "r1",
  projectId: "p1",
  source: "factory",
  itemId: "i1",
  prNumber: 12,
  headSha: "abc1234",
  forSessionId: null,
  sessionId: "s9",
  checkIds: ["c1"],
  state: "failed",
  results: [
    { checkId: "c1", number: 1, state: "fail", observation: "Nothing happened.", screenshot: null },
  ],
  detail: null,
  nudgedAt: null,
  startedAt: ts,
  endedAt: ts,
};

describe("owner checks contracts", () => {
  it("round-trip a check, a run and the editor's response", () => {
    expect(OwnerCheck.parse(check)).toEqual(check);
    expect(OwnerCheckRun.parse(run)).toEqual(run);
    const res = { checks: [check], runs: [run], devServer: true };
    expect(OwnerChecksResponse.parse(JSON.parse(JSON.stringify(res)))).toEqual(res);
  });

  it("round-trip their events", () => {
    for (const env of [
      { type: "factory.owner_check.updated", payload: { check } },
      { type: "factory.owner_check_run.updated", payload: { run } },
    ]) {
      const e = { seq: 1, ts, sessionId: null, ...env };
      expect(EventEnvelope.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
    }
  });

  it("add the owner_checks merge check and a switch that is on by default", () => {
    expect(MergeCheckName.options).toContain("owner_checks");
    expect(FactoryTuning.parse({}).ownerChecks).toBe(true);
    expect(FactoryTuning.parse({ ownerChecks: false }).ownerChecks).toBe(false);
  });

  it("validate writes, runs and submissions", () => {
    expect(OwnerCheckWriteRequest.safeParse({ text: "  " }).success).toBe(false);
    expect(OwnerCheckWriteRequest.safeParse({ text: "x".repeat(501) }).success).toBe(false);
    expect(OwnerCheckRunRequest.safeParse({ sessionId: "s1" }).success).toBe(true);
    expect(OwnerCheckRunRequest.safeParse({}).success).toBe(false);
    expect(OwnerCheckRunRequest.safeParse({ sessionId: "s1", itemId: "i1" }).success).toBe(false);
    expect(
      OwnerChecksSubmission.safeParse({
        results: [{ number: 1, state: "pass", observation: "It worked." }],
      }).success,
    ).toBe(true);
    expect(OwnerChecksSubmission.safeParse({ results: [] }).success).toBe(false);
  });

  it("withhold an observation that repeats the scenario's wording", () => {
    const scenario = "I can export the summary as a PDF.";
    expect(builderSafeObservation("The export button did nothing.", scenario)).toBe(
      "The export button did nothing.",
    );
    expect(
      builderSafeObservation("Tried: i can  EXPORT the summary as a pdf, but nothing", scenario),
    ).toBe(OBSERVATION_WITHHELD);
  });

  it("withhold an observation that closely paraphrases the scenario", () => {
    const scenario = "I can export the monthly summary as a PDF and open it in my mail app.";
    // punctuation changes
    expect(
      builderSafeObservation(
        "Result: I can export the monthly summary, as a PDF - and open it in my mail app",
        scenario,
      ),
    ).toBe(OBSERVATION_WITHHELD);
    // reordered words
    expect(
      builderSafeObservation(
        "open it in my mail app and I can export the monthly summary as a PDF",
        scenario,
      ),
    ).toBe(OBSERVATION_WITHHELD);
    // small paraphrase
    expect(
      builderSafeObservation(
        "I could export the monthly summary as a PDF and open it in the mail app",
        scenario,
      ),
    ).toBe(OBSERVATION_WITHHELD);
    // ordinary diagnostic note is kept
    const ok = "The export button did nothing and the console showed a 500 error on the summary.";
    expect(builderSafeObservation(ok, scenario)).toBe(ok);
  });
});
