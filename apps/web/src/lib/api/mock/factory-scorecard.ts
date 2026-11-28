import {
  type FactoryScorecard,
  type FactoryScorecardRow,
  REVIEWER_SCORE_MIN_REVIEWS,
  type ReviewerQuality,
  type ReviewerQualityRow,
  type ScorecardAgent,
  type ScorecardDays,
} from "@codeden/contracts";

/**
 * The mock client's factory scorecard (§10.1): a plausible month of work for a factory project,
 * by builder and reviewer pair, scaled to the window. Builder and reviewer rows are sums of the
 * pairs, as the server's would be.
 */

const HOUR = 60 * 60 * 1000;

const opus: ScorecardAgent = { provider: "claude", model: "claude-opus-4-5" };
const sonnet: ScorecardAgent = { provider: "claude", model: "claude-sonnet-4-5" };
const codex: ScorecardAgent = { provider: "codex", model: "gpt-5.5" };

/**
 * Per 30 days: builder, reviewer, merged, failed, first pass, revise rounds, reverted, $, hours,
 * merges spot-checked and the problems people found.
 */
const PAIRS: Array<
  [
    ScorecardAgent,
    ScorecardAgent | null,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
> = [
  [opus, codex, 14, 1, 10, 6, 1, 61.6, 3.2, 4, 0],
  [codex, opus, 11, 2, 6, 9, 0, 38.5, 4.1, 3, 1],
  [sonnet, codex, 8, 2, 4, 8, 1, 17.2, 5.0, 2, 1],
  [codex, null, 3, 0, 3, 0, 0, 2.4, 0.8, 1, 0],
];

const scale = (n: number, days: ScorecardDays) => Math.round((n * days) / 30);

function pairRow(p: (typeof PAIRS)[number], days: ScorecardDays): FactoryScorecardRow {
  const [builder, reviewer, merged30, failed30, first30, rounds30, reverted30, usd30, hours] = p;
  const [, , , , , , , , , spot30, problems30] = p;
  const merged = scale(merged30, days);
  const failed = scale(failed30, days);
  const costUsd = Math.round(((usd30 * days) / 30) * 100) / 100;
  return {
    key: JSON.stringify([builder, reviewer]),
    builder,
    reviewer,
    finished: merged + failed,
    merged,
    failed,
    firstPass: Math.min(merged, scale(first30, days)),
    reviseRounds: scale(rounds30, days),
    reverted: Math.min(merged, scale(reverted30, days)),
    medianMergeMs: merged > 0 ? hours * HOUR : null,
    costUsd,
    costPerMergeUsd: merged > 0 ? Math.round((costUsd / merged) * 100) / 100 : null,
    estimatedUsd: costUsd,
    unpricedTurns: 0,
    apiEquivalent: true,
    spotChecked: Math.min(merged, scale(spot30, days)),
    spotProblems: Math.min(merged, scale(problems30, days)),
  };
}

/** Rows summed by one side of the pair; the median is the merge-weighted mean of the pairs'. */
function sumBy(
  pairs: FactoryScorecardRow[],
  side: (r: FactoryScorecardRow) => Pick<FactoryScorecardRow, "builder" | "reviewer">,
): FactoryScorecardRow[] {
  const rows = new Map<string, FactoryScorecardRow & { weighted: number }>();
  for (const p of pairs) {
    const group = side(p);
    const key = JSON.stringify([group.builder, group.reviewer]);
    const r = rows.get(key) ?? {
      ...p,
      ...group,
      key,
      finished: 0,
      merged: 0,
      failed: 0,
      firstPass: 0,
      reviseRounds: 0,
      reverted: 0,
      costUsd: 0,
      estimatedUsd: 0,
      spotChecked: 0,
      spotProblems: 0,
      weighted: 0,
    };
    r.finished += p.finished;
    r.merged += p.merged;
    r.failed += p.failed;
    r.firstPass += p.firstPass;
    r.reviseRounds += p.reviseRounds;
    r.reverted += p.reverted;
    r.spotChecked += p.spotChecked;
    r.spotProblems += p.spotProblems;
    r.costUsd = Math.round((r.costUsd + p.costUsd) * 100) / 100;
    r.estimatedUsd = r.costUsd;
    r.weighted += (p.medianMergeMs ?? 0) * p.merged;
    rows.set(key, r);
  }
  return [...rows.values()]
    .map(({ weighted, ...r }) => ({
      ...r,
      medianMergeMs: r.merged > 0 ? weighted / r.merged : null,
      costPerMergeUsd: r.merged > 0 ? Math.round((r.costUsd / r.merged) * 100) / 100 : null,
    }))
    .sort((a, b) => b.finished - a.finished || b.merged - a.merged);
}

/** The demo scorecard; empty outside a factory mode. */
export function demoScorecard(
  projectId: string,
  days: ScorecardDays,
  factory: boolean,
): FactoryScorecard {
  const pairs = factory
    ? PAIRS.map((p) => pairRow(p, days))
        .filter((r) => r.finished > 0)
        .sort((a, b) => b.finished - a.finished || b.merged - a.merged)
    : [];
  return {
    projectId,
    days,
    since: new Date(Date.now() - days * 24 * HOUR).toISOString(),
    finished: pairs.reduce((n, r) => n + r.finished, 0),
    builders: sumBy(pairs, (r) => ({ builder: r.builder, reviewer: null })),
    reviewers: sumBy(pairs, (r) => ({ builder: null, reviewer: r.reviewer })),
    pairs,
    ...(factory
      ? {
          earned: {
            docs: { count: 5, required: 5, earned: true },
            bug: { count: 4, required: 5, earned: false },
            feature: { count: 0, required: 5, earned: false },
          },
          reviewQuality: demoReviewQuality(days),
        }
      : {}),
  };
}

/** Reviewer models for the demo: one solid, one half broken, one with too few reviews. */
function demoReviewQuality(days: ScorecardDays): ReviewerQuality {
  const row = (
    reviewer: ScorecardAgent,
    reviews: number,
    noVerdict: number,
    approvals: number,
    approvalsWithProblems: number,
    costUsd: number | null,
  ): ReviewerQualityRow => {
    const n = (v: number) => Math.round((v * days) / 30);
    const total = n(reviews);
    return {
      key: JSON.stringify([reviewer.provider, reviewer.model]),
      reviewer,
      reviews: total,
      noVerdict: Math.min(total, n(noVerdict)),
      approvals: n(approvals),
      approvalsWithProblems: Math.min(n(approvals), n(approvalsWithProblems)),
      laterProblems: Math.min(n(approvals), n(approvalsWithProblems)),
      costUsd: costUsd === null ? 0 : Math.round(((costUsd * days) / 30) * 100) / 100,
      costPerReviewUsd:
        costUsd === null || total === 0
          ? null
          : Math.round((costUsd * days * 100) / 30 / total) / 100,
      estimatedUsd: 0,
      unpricedTurns: costUsd === null ? 3 : 0,
      apiEquivalent: false,
      tooFew: total < REVIEWER_SCORE_MIN_REVIEWS,
    };
  };
  return {
    minReviews: REVIEWER_SCORE_MIN_REVIEWS,
    rows: [
      row(codex, 22, 1, 20, 2, 9.4),
      row({ provider: "cursor", model: "composer-2" }, 33, 9, 12, 0, null),
      row(opus, 3, 0, 3, 0, 2.1),
    ],
    unlinkedBugs: 2,
    unreviewedMerges:
      days === 7
        ? []
        : [
            {
              itemId: "demo-unreviewed",
              title: "Add a history table to the database",
              issueNumber: 185,
              prNumber: 190,
              mergedAt: new Date(Date.now() - 3 * 24 * HOUR).toISOString(),
              why: "no_verdict",
            },
          ],
  };
}
