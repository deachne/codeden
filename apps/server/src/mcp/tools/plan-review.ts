import { SubmitPlanOpinionsInput, SubmitPlanReviewInput } from "@codeden/contracts";
import { defineTool, ToolError } from "../define";
import { asTool, forSession } from "./factory/shared";

/**
 * `submit_plan_review`: a reviewer of a plan (§8.5, second opinions) hands over its findings.
 * Listed only to a reviewer session of a review that is still gathering reports.
 */
export const submitPlanReview = defineTool({
  name: "submit_plan_review",
  description:
    "Hand over your second opinion on the project's plan: your findings in plain everyday words, most important first (the point, where it comes from, what you'd change). Call it once, then stop. You work alone and read-only; you can't ask the owner anything, so say when a point needs their decision.",
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: forSession((services, id) => services.planReviews.isReviewer(id)),
  input: SubmitPlanReviewInput,
  handler: (input, { services, sessionId }) => {
    if (!services.planReviews.isReviewer(sessionId))
      throw new ToolError("Only a reviewer of a plan can hand over a review");
    return asTool(() => {
      services.planReviews.submitReview(sessionId, input.text);
      return "Your review was saved. Nothing more to do: stop here.";
    });
  },
});

/**
 * `submit_plan_opinions`: the Planner settles the reviewers' points into the table the owner
 * accepts or rejects row by row. Listed only to the Planner of a review waiting for its table.
 */
export const submitPlanOpinions = defineTool({
  name: "submit_plan_opinions",
  description:
    "Settle the reviewers' points into the table the owner will accept or reject, row by row: for each point its text, who raised it, whether you agree after checking it against the actual code, what you would do (one short sentence), why (one line), and `askOwner: true` when only the owner can decide it. Plain everyday words: the owner isn't an engineer. The plan is not changed by this: accepted rows come back to you afterwards.",
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: forSession((services, id) => services.planReviews.isSettler(id)),
  input: SubmitPlanOpinionsInput,
  handler: (input, { services, sessionId }) => {
    if (!services.planReviews.isSettler(sessionId))
      throw new ToolError("Only the Planner of a plan review can settle its table");
    return asTool(() => {
      const review = services.planReviews.submitOpinions(sessionId, input.rows);
      return `The table (${review.rows.length} rows) is on the plan screen. Tell the owner, in a sentence or two, to accept or reject each row there. Don't change the plan yet.`;
    });
  },
});
