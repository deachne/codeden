import { describe, expect, it } from "vitest";
import {
  DecidePlanReviewRowRequest,
  EventEnvelope,
  PlanReview,
  PlanReviewOptions,
  StartPlanReviewRequest,
  SubmitPlanOpinionsInput,
  SubmitPlanReviewInput,
} from "../src";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

const now = "2026-11-27T10:00:00.000Z";
const review = {
  id: "r1",
  projectId: "p1",
  status: "ready",
  planSha256: "abc",
  capUsd: 3,
  reviewers: [
    {
      sessionId: "s1",
      providerId: "codex",
      displayName: "Codex",
      status: "stopped_cap",
      text: null,
    },
  ],
  settlerSessionId: "s-planner",
  rows: [
    {
      id: "row1",
      point: "No database",
      raisedBy: ["Codex"],
      stance: "agree",
      call: "Add one",
      reason: "The code has none",
    },
  ],
  createdAt: now,
  updatedAt: now,
};

// §8.5 Second opinions on a plan.
describe("plan review contracts", () => {
  it("round-trips a review; a row starts pending and doesn't ask the owner by default", () => {
    const parsed = roundTrip(PlanReview, review);
    expect(parsed.rows[0]).toMatchObject({ decision: "pending", askOwner: false });
    expect(parsed.reviewers[0]?.costUsd).toBe(0);
  });

  it("carries the review in a persisted event", () => {
    const event = {
      seq: 1,
      sessionId: null,
      ts: now,
      type: "project.plan_review.updated",
      payload: { review },
    };
    expect(EventEnvelope.parse(event).type).toBe("project.plan_review.updated");
  });

  it("limits what Go and the agent tools accept", () => {
    roundTrip(StartPlanReviewRequest, { reviewers: ["codex", "gemini"], capUsd: 3 });
    expect(StartPlanReviewRequest.safeParse({ reviewers: [], capUsd: 3 }).success).toBe(false);
    expect(StartPlanReviewRequest.safeParse({ reviewers: ["codex"], capUsd: 0 }).success).toBe(
      false,
    );
    expect(SubmitPlanReviewInput.safeParse({ text: "  " }).success).toBe(false);
    expect(SubmitPlanOpinionsInput.safeParse({ rows: [] }).success).toBe(false);
    expect(DecidePlanReviewRowRequest.safeParse({ decision: "maybe" }).success).toBe(false);
    roundTrip(DecidePlanReviewRowRequest, { decision: "accepted" });
  });

  it("round-trips the box's options", () => {
    roundTrip(PlanReviewOptions, {
      candidates: [
        {
          providerId: "codex",
          displayName: "Codex",
          model: null,
          maker: "OpenAI",
          ready: true,
          reason: null,
          differentMaker: true,
          defaultOn: true,
          roughUsd: 1,
        },
      ],
      settlerUsd: 1.5,
      defaultCapUsd: 3,
    });
  });
});
