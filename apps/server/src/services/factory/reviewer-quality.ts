import {
  ACTIVE_SESSION_STATUSES,
  type BillingMode,
  type FactoryItem,
  REVIEWER_SCORE_MIN_REVIEWS,
  type ReviewerQuality,
  type ReviewerQualityRow,
  type ScorecardAgent,
  type ScorecardDays,
  type Session,
  type UnreviewedMerge,
  type UnreviewedWhy,
} from "@codeden/contracts";
import type { FactoryContext } from "./context";
import type { LedgerTurn } from "./item-cost";
import { bugSources } from "./later-problems";
import { scorecardOutcome } from "./scorecard";
import { REVIEW_WORK_KEY_PREFIX } from "./sessions";

/**
 * The reviewer scorecard (§10.1, Visibility): for each reviewer model, how many reviews it did,
 * how many ended without a verdict, what the review step cost, and how many bugs were filed later
 * against work it approved; plus the bugs that name no source and the merges with no real
 * review. Computed on read from what the factory already recorded (review sessions and their
 * `factory_submit_review` calls, the ledger, the items); nothing is stored or back-filled.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The tool a reviewer ends its review with; a session that never called it gave no verdict. */
export const SUBMIT_REVIEW_TOOL = "factory_submit_review";

/** Most merges without a real review listed (the count is exact below it). */
const UNREVIEWED_LISTED = 50;

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** One review session of the window, as the tally reads it. */
export interface ReviewSessionFact {
  session: Pick<Session, "id" | "provider" | "model" | "status">;
  /** It made a successful `factory_submit_review` call. */
  submitted: boolean;
}

/** What the tally needs besides the items. */
export interface ReviewerQualityFacts {
  /** Review sessions created in the window. */
  reviews: ReviewSessionFact[];
  /** The model each approving session ran (null: the provider's default), by session id. */
  models: ReadonlyMap<string, string | null>;
  /** Ledger turns by session id, for the review sessions. */
  turns: ReadonlyMap<string, LedgerTurn[]>;
  /** How each provider is paid for, for "API-equivalent" costs (§12.6). */
  billing: Record<string, BillingMode>;
}

interface Tally {
  key: string;
  reviewer: ScorecardAgent;
  reviews: number;
  noVerdict: number;
  approvals: number;
  problemItems: Set<string>;
  laterProblems: number;
  costUsd: number;
  estimatedUsd: number;
  unpricedTurns: number;
  apiEquivalent: boolean;
}

function tallyFor(rows: Map<string, Tally>, reviewer: ScorecardAgent): Tally {
  const key = JSON.stringify([reviewer.provider, reviewer.model]);
  let row = rows.get(key);
  if (!row) {
    row = {
      key,
      reviewer,
      reviews: 0,
      noVerdict: 0,
      approvals: 0,
      problemItems: new Set(),
      laterProblems: 0,
      costUsd: 0,
      estimatedUsd: 0,
      unpricedTurns: 0,
      apiEquivalent: false,
    };
    rows.set(key, row);
  }
  return row;
}

function toRow(t: Tally): ReviewerQualityRow {
  const costUsd = round(t.costUsd);
  return {
    key: t.key,
    reviewer: t.reviewer,
    reviews: t.reviews,
    noVerdict: t.noVerdict,
    approvals: t.approvals,
    approvalsWithProblems: t.problemItems.size,
    laterProblems: t.laterProblems,
    costUsd,
    // Nothing priced: unknown, never $0.00.
    costPerReviewUsd: t.reviews > 0 && costUsd > 0 ? round(t.costUsd / t.reviews) : null,
    estimatedUsd: round(t.estimatedUsd),
    unpricedTurns: t.unpricedTurns,
    apiEquivalent: t.apiEquivalent,
    tooFew: t.reviews < REVIEWER_SCORE_MIN_REVIEWS,
  };
}

/** Why a merge a person made had no approving review, or null when it had one (or needed none). */
export function unreviewedWhy(item: FactoryItem): UnreviewedWhy | null {
  if (item.review?.verdict === "approve") return null;
  const check = item.checks.find((c) => c.name === "review");
  // The docs pipeline merges documentation without an agent review, by design.
  if (item.type === "docs" && check?.state === "skipped") return null;
  if (item.mergePath !== null) return null;
  if (item.review) return "failed";
  if (check?.state === "skipped") return "skipped";
  return check?.state === "fail" ? "failed" : "no_verdict";
}

/** The review sessions of the window that are over: not working, and not the one still awaited. */
function finished(fact: ReviewSessionFact, verifying: ReadonlySet<string>): boolean {
  const { status, id } = fact.session;
  if ((ACTIVE_SESSION_STATUSES as readonly string[]).includes(status)) return false;
  // Idle with no verdict yet: the factory nudges it first, so it isn't a failed review yet.
  return fact.submitted || !(status === "idle" && verifying.has(id));
}

/**
 * The reviewer scorecard over `items` (the project's, any stage) for the `days` before `now`.
 * Reviews, no-verdict reviews and cost count for the model of each review session; approvals and
 * the bugs filed later for the model that approved the work.
 */
export function reviewerQuality(
  items: FactoryItem[],
  facts: ReviewerQualityFacts,
  now: Date,
  days: ScorecardDays,
): ReviewerQuality {
  const end = now.getTime();
  const since = end - days * DAY_MS;
  const rows = new Map<string, Tally>();
  const verifying = new Set(
    items.flatMap((i) =>
      i.stage === "verifying" && i.reviewerSessionId ? [i.reviewerSessionId] : [],
    ),
  );
  for (const fact of facts.reviews) {
    if (!finished(fact, verifying)) continue;
    const s = fact.session;
    const row = tallyFor(rows, { provider: s.provider, model: s.model });
    row.reviews++;
    if (!fact.submitted) row.noVerdict++;
    for (const t of facts.turns.get(s.id) ?? []) {
      const tokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
      row.costUsd += t.costUsd;
      if (t.costSource === "estimated") row.estimatedUsd += t.costUsd;
      if (t.costSource === "unpriced" && tokens > 0) row.unpricedTurns++;
      row.apiEquivalent ||= facts.billing[t.provider] === "subscription";
    }
  }

  const cohort = items.filter((i) => scorecardOutcome(i, since, end) === "merged");
  const approver = new Map<string, Tally>();
  for (const item of cohort) {
    if (item.review?.verdict !== "approve" || !item.reviewerProvider) continue;
    const model =
      (item.reviewerSessionId ? facts.models.get(item.reviewerSessionId) : null) ?? null;
    const row = tallyFor(rows, { provider: item.reviewerProvider, model });
    row.approvals++;
    approver.set(item.id, row);
  }

  // Bugs filed later that name an approved item: charged to the model that approved it.
  let unlinkedBugs = 0;
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const [bugId, source] of bugSources(items)) {
    if (source.kind === "linked") {
      const row = approver.get(source.item.id);
      if (row) {
        row.laterProblems++;
        row.problemItems.add(source.item.id);
      }
    } else if (source.kind === "unlinked") {
      // Bugs are only in `bugSources` when `isLaterBug`; count the ones filed in the window.
      const filed = Date.parse(byId.get(bugId)?.createdAt ?? "");
      if (filed >= since && filed <= end) unlinkedBugs++;
    }
  }

  const unreviewedMerges: UnreviewedMerge[] = [];
  for (const item of cohort) {
    const why = unreviewedWhy(item);
    if (!why || item.mergedAt === null) continue;
    unreviewedMerges.push({
      itemId: item.id,
      title: item.title,
      issueNumber: item.issue?.number ?? null,
      prNumber: item.pr?.number ?? null,
      mergedAt: item.mergedAt,
      why,
    });
  }
  unreviewedMerges.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));

  const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    minReviews: REVIEWER_SCORE_MIN_REVIEWS,
    rows: [...rows.values()]
      .map(toRow)
      .sort((a, b) => b.reviews - a.reviews || b.approvals - a.approvals || byKey(a.key, b.key)),
    unlinkedBugs,
    unreviewedMerges: unreviewedMerges.slice(0, UNREVIEWED_LISTED),
  };
}

/**
 * The reviewer scorecard from the store: the window's review sessions (looked up by work key, not
 * through the capped session list) and whether each sent a verdict, the models of the approving
 * sessions and what the review sessions cost, from one ledger read.
 */
export async function buildReviewerQuality(
  ctx: Pick<FactoryContext, "now" | "store" | "repo" | "usage">,
  projectId: string,
  days: ScorecardDays,
): Promise<ReviewerQuality> {
  const now = ctx.now();
  const end = now.getTime();
  const since = end - days * DAY_MS;
  const items = ctx.store.items(projectId);
  const sessions = ctx.repo.withWorkKeyPrefix(
    projectId,
    REVIEW_WORK_KEY_PREFIX,
    new Date(since).toISOString(),
  );
  const submitted = ctx.repo.sessionsWithToolCall(
    sessions.map((s) => s.id),
    SUBMIT_REVIEW_TOOL,
  );
  const models = ctx.repo.modelsOf(
    items.flatMap((i) => (i.reviewerSessionId ? [i.reviewerSessionId] : [])),
  );
  const turns = new Map<string, LedgerTurn[]>();
  if (sessions.length > 0 && ctx.usage.turnsOf) {
    for (const t of ctx.usage.turnsOf(new Set(sessions.map((s) => s.id)))) {
      turns.set(t.sessionId, [...(turns.get(t.sessionId) ?? []), t]);
    }
  }
  const billing = (await ctx.usage.providerBilling?.().catch(() => ({}))) ?? {};
  return reviewerQuality(
    items,
    {
      reviews: sessions.map((session) => ({ session, submitted: submitted.has(session.id) })),
      models,
      turns,
      billing,
    },
    now,
    days,
  );
}
