import { z } from "zod";
import { Id, ProviderId, Timestamp } from "./common";
import { ScorecardDays } from "./factory-scorecard";

/**
 * The builder score (§12.6, §10.1): a live score for each builder model on the owner's real work,
 * tallied from what the factory already records (its items, their reviews, reverts and what their
 * sessions cost). Computed when read, across every project or one; nothing is stored.
 *
 * Counting follows the scorecard (`FactoryScorecard`): work that merged in the window, or failed
 * in it because of its own work. Work still in flight is counted apart as `inProgress`, never as
 * a failure. Each item counts for the builder of its last attempt.
 */

/** Fewer finished changes than this and a model's rates aren't shown as percentages. */
export const BUILDER_SCORE_MIN_CHANGES = 5;

/** `GET /api/usage/builders?days=30&projectId=`: the window (30 days by default), optionally one project. */
export const BuilderScoreQuery = z.object({
  days: z.coerce.number().pipe(ScorecardDays).default(30),
  projectId: Id.optional(),
});
export type BuilderScoreQuery = z.infer<typeof BuilderScoreQuery>;

/** One builder model's score over the window. */
export const BuilderScoreRow = z.object({
  /** Stable within a response: the provider and model. */
  key: z.string().min(1),
  provider: ProviderId,
  /** The model the builder session ran; null: the provider's default (none was reported). */
  model: z.string().min(1).nullable(),
  /** Changes that finished in the window: `merged` + `failed`. */
  finished: z.int().nonnegative(),
  /** Merged in the window, including merges reverted since. */
  merged: z.int().nonnegative(),
  /** Failed in the window because of their own work, without a merge. */
  failed: z.int().nonnegative(),
  /** Merged without a revise round (a failed review or check) and not reverted. */
  firstPass: z.int().nonnegative(),
  /** Revise rounds over the finished changes (divide by `finished` for the average). */
  reviseRounds: z.int().nonnegative(),
  /** Merges reverted because CI on the default branch failed after them. */
  reverted: z.int().nonnegative(),
  /** Changes this builder has in flight right now (any time, not only the window). */
  inProgress: z.int().nonnegative(),
  /** What the finished changes cost: every session of each item, all time. */
  costUsd: z.number().nonnegative(),
  /** `costUsd` per merged change, failures included; null without a merge. */
  costPerMergeUsd: z.number().nonnegative().nullable(),
  /** Part of `costUsd` estimated from the price table rather than reported. */
  estimatedUsd: z.number().nonnegative(),
  /** Turns with no reported cost and no price to estimate one from: never shown as $0.00. */
  unpricedTurns: z.int().nonnegative(),
  /** A provider of these sessions is a subscription login: an API-equivalent figure (§12.6). */
  apiEquivalent: z.boolean(),
  /** `finished` is below `minChanges`: too few to judge, so the table shows no percentages. */
  tooFew: z.boolean(),
});
export type BuilderScoreRow = z.infer<typeof BuilderScoreRow>;

/** `GET /api/usage/builders`. Rows: most finished changes first, then in progress. */
export const BuilderScore = z.object({
  days: ScorecardDays,
  /** Start of the window (`days` before the response was built). */
  since: Timestamp,
  /** `BUILDER_SCORE_MIN_CHANGES`, so the page doesn't repeat the number. */
  minChanges: z.int().positive(),
  /** Changes that finished in the window, over every row. */
  finished: z.int().nonnegative(),
  /** Changes in flight, over every row. */
  inProgress: z.int().nonnegative(),
  rows: z.array(BuilderScoreRow),
});
export type BuilderScore = z.infer<typeof BuilderScore>;
