import {
  DEFAULT_PLAN_REVIEWERS,
  type PlanReviewCandidate,
  type PlanReviewOptions,
  type ProviderInfo,
} from "@codeden/contracts";

/**
 * The reviewers the box before **Go** offers (§8.5), chosen from what each provider says about
 * itself (read-only enforced, MCP tools, its maker) and whether it is ready: never by provider id.
 */

/** A rough cost of one reviewer's pass over a plan (USD), shown as "about". */
export const ROUGH_REVIEWER_USD = 1;
/** A rough cost of the Planner settling the table (USD). */
export const ROUGH_SETTLER_USD = 1.5;
/**
 * The cap offered for each reviewer (USD): higher than a quick check, since a review reads real
 * code, and a reviewer that goes over is stopped. The owner can change it before Go.
 */
export const DEFAULT_PLAN_REVIEW_CAP_USD = 3;

/** What the server knows about a provider's readiness (`FactoryService.providerChoices`). */
export interface ReadyChoice {
  id: string;
  name: string;
  runnable: boolean;
  /** Why it can't run, as a phrase after its name; null when it can. */
  reason: string | null;
}

/**
 * Whether a provider can review at all: it enforces read-only (§11.2). One that can't load
 * CodeDen's tools still reviews: its last reply stands in for the report it couldn't submit.
 */
export function canReview(info: ProviderInfo): boolean {
  return info.capabilities.readOnly === true;
}

/**
 * Candidates in the order the box shows them: ready ones first, those from another company than
 * the Planner's provider before the rest, then as the runner lists them. The first
 * `DEFAULT_PLAN_REVIEWERS` ready ones are ticked.
 */
export function planReviewOptions(args: {
  providers: ProviderInfo[];
  choices: ReadyChoice[];
  plannerProvider: string;
}): PlanReviewOptions {
  const planner = args.providers.find((p) => p.id === args.plannerProvider);
  const plannerMaker = planner?.maker ?? planner?.id ?? args.plannerProvider;
  const pool = args.providers.filter((p) => canReview(p));
  const ranked = pool
    .map((info, order) => {
      const choice = args.choices.find((c) => c.id === info.id);
      const ready = choice?.runnable ?? false;
      const different = (info.maker ?? info.id) !== plannerMaker;
      return { info, choice, ready, different, order };
    })
    .sort(
      (a, b) =>
        Number(b.ready) - Number(a.ready) ||
        Number(b.different) - Number(a.different) ||
        a.order - b.order,
    );
  let ticked = 0;
  const candidates: PlanReviewCandidate[] = ranked.map(({ info, choice, ready, different }) => {
    const defaultOn = ready && ticked < DEFAULT_PLAN_REVIEWERS;
    if (defaultOn) ticked += 1;
    return {
      providerId: info.id,
      displayName: choice?.name ?? info.displayName,
      model: null,
      maker: info.maker ?? null,
      ready,
      reason: ready ? null : (choice?.reason ?? "isn't available right now"),
      differentMaker: different,
      defaultOn,
      roughUsd: ROUGH_REVIEWER_USD,
    };
  });
  return {
    candidates,
    settlerUsd: ROUGH_SETTLER_USD,
    defaultCapUsd: DEFAULT_PLAN_REVIEW_CAP_USD,
  };
}
