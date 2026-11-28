import {
  type DecidePlanReviewRowRequest,
  PlanReview,
  PlanReviewOptions,
  PlanReviewResponse,
  type StartPlanReviewRequest,
} from "@codeden/contracts";
import type { Fetcher } from "./http";

/** Second opinions on a project's plan (§8.5). Every call is the owner's. */
export interface PlanReviewApi {
  /** The project's newest review, or none. */
  current(projectId: string): Promise<PlanReview | null>;
  /** What the box before Go shows: the reviewers on offer, a rough cost and the cap. */
  options(projectId: string): Promise<PlanReviewOptions>;
  /** "Go": starts the reviewers. Nothing starts before it. */
  start(projectId: string, req: StartPlanReviewRequest): Promise<PlanReview>;
  /** Accept or reject one row of the table. */
  decide(
    projectId: string,
    rowId: string,
    decision: DecidePlanReviewRowRequest["decision"],
  ): Promise<PlanReview>;
  /** Send the accepted rows to the Planner, which folds them into the plan. */
  apply(projectId: string): Promise<PlanReview>;
  /** Stop gathering opinions, or drop the table. */
  cancel(projectId: string): Promise<PlanReview>;
}

const enc = encodeURIComponent;

export function httpPlanReviewApi(http: Fetcher): PlanReviewApi {
  const p = (id: string) => `/projects/${enc(id)}/plan-review`;
  const review = (v: unknown) => PlanReview.parse(v);
  return {
    current: (id) => http.get(p(id), (v) => PlanReviewResponse.parse(v).review),
    options: (id) => http.get(`${p(id)}/options`, (v) => PlanReviewOptions.parse(v)),
    start: (id, req) => http.post(p(id), req, review),
    decide: (id, rowId, decision) => http.post(`${p(id)}/rows/${enc(rowId)}`, { decision }, review),
    apply: (id) => http.post(`${p(id)}/apply`, {}, review),
    cancel: (id) => http.post(`${p(id)}/cancel`, {}, review),
  };
}
