import type { PlanReview, PlanReviewRow } from "@codeden/contracts";
import { ApiRequestError } from "../http";
import type { PlanReviewApi } from "../plan-review-api";
import { uid } from "./live";
import type { MockWorld } from "./world";

/**
 * The mock server's second opinions on a plan (§8.5): reviewers finish after a moment, the
 * Planner settles a small table, and decisions are kept. It lets the UI be tried without a server.
 */
export function mockPlanReviewApi(world: MockWorld): PlanReviewApi {
  const reviews = new Map<string, PlanReview>();
  const save = (review: PlanReview): PlanReview => {
    const next = { ...review, updatedAt: new Date().toISOString() };
    reviews.set(next.projectId, next);
    world.emitDomain({
      type: "project.plan_review.updated",
      sessionId: null,
      payload: { review: next },
    });
    return next;
  };
  const current = (projectId: string): PlanReview => {
    const review = reviews.get(projectId);
    if (!review) throw new ApiRequestError(409, "no_plan_review", "No second opinions yet");
    return review;
  };
  const row = (point: string, over: Partial<PlanReviewRow> = {}): PlanReviewRow => ({
    id: uid("review"),
    point,
    raisedBy: ["Codex"],
    stance: "agree",
    call: "Add it to the plan",
    reason: "I checked the code and it holds",
    askOwner: false,
    decision: "pending",
    ...over,
  });
  return {
    async current(projectId) {
      return reviews.get(projectId) ?? null;
    },
    async options() {
      return {
        candidates: [
          ["codex", "Codex", "OpenAI"],
          ["gemini", "Gemini CLI", "Google"],
          ["cursor", "Cursor", "Cursor"],
        ].map(([providerId, displayName, maker], i) => ({
          providerId: providerId as string,
          displayName: displayName as string,
          model: null,
          maker: maker as string,
          ready: true,
          reason: null,
          differentMaker: true,
          defaultOn: i < 3,
          roughUsd: 1,
        })),
        settlerUsd: 1.5,
        defaultCapUsd: 3,
      };
    },
    async start(projectId, req) {
      const now = new Date().toISOString();
      const started = save({
        id: uid("review"),
        projectId,
        status: "reviewing",
        planSha256: null,
        capUsd: req.capUsd,
        reviewers: req.reviewers.map((id) => ({
          sessionId: uid("rev"),
          providerId: id,
          displayName: id === "gemini" ? "Gemini CLI" : id[0]?.toUpperCase() + id.slice(1),
          status: "running" as const,
          text: null,
          costUsd: 0,
        })),
        settlerSessionId: uid("planner"),
        rows: [],
        createdAt: now,
        updatedAt: now,
      });
      setTimeout(() => {
        const r = reviews.get(projectId);
        if (r?.id !== started.id || r.status !== "reviewing") return;
        save({
          ...r,
          status: "settling",
          reviewers: r.reviewers.map((x) => ({
            ...x,
            status: "done",
            text: "Findings.",
            costUsd: 0.4,
          })),
        });
        setTimeout(() => {
          const s = reviews.get(projectId);
          if (s?.id !== started.id || s.status !== "settling") return;
          save({
            ...s,
            status: "ready",
            rows: [
              row("The plan doesn't say where the data is stored"),
              row("A hosting plan is missing", {
                askOwner: true,
                call: "Ask the owner",
                reason: "Only they know the budget",
              }),
              row("Rename the first version to a pilot", {
                stance: "disagree",
                reason: "Cosmetic: no change to what gets built",
              }),
            ],
          });
        }, 1500);
      }, 1500);
      return started;
    },
    async decide(projectId, rowId, decision) {
      const review = current(projectId);
      return save({
        ...review,
        rows: review.rows.map((r) => (r.id === rowId ? { ...r, decision } : r)),
      });
    },
    async apply(projectId) {
      return save({ ...current(projectId), status: "applied" });
    },
    async cancel(projectId) {
      return save({ ...current(projectId), status: "cancelled" });
    },
  };
}
