import { z } from "zod";
import { Id, Timestamp } from "./common";

/**
 * Owner checks (§10.1, Owner checks): short scenarios in plain words that the project's owner
 * writes ("I paste a YouTube link and get a condensed version with timestamps"). CodeDen keeps
 * them in its own data folder, per project, never in the repository, so the agents that build and
 * review a change never see them. Before a factory pull request merges, a separate tryout agent
 * starts the app from the PR's head (`devServer` in `.codeden/project.json`), uses it through the
 * browser tools the way a person would, and records pass or fail per scenario with a screenshot
 * and one sentence of what it saw. The `owner_checks` merge check passes when every scenario
 * passed; a failure goes back to the builder with the scenario's number and what the tryout agent
 * saw, never the scenario's wording. Each scenario keeps its last result: the owner's list of
 * what is proven to work.
 */

/** Longest owner check a person can write. */
export const OWNER_CHECK_MAX = 500;

/** Most owner checks a project can have. */
export const MAX_OWNER_CHECKS = 20;

/** Longest observation the tryout agent records for one scenario (one sentence). */
export const OWNER_CHECK_OBSERVATION_MAX = 500;

/** Work key prefix of the tryout sessions that run the owner checks. */
export const OWNER_CHECKS_WORK_KEY_PREFIX = "factory:owner-checks:";

export const OwnerCheckState = z.enum(["pass", "fail"]);
export type OwnerCheckState = z.infer<typeof OwnerCheckState>;

/** A scenario's result in one tryout run. */
export const OwnerCheckResult = z.object({
  state: OwnerCheckState,
  /** One sentence of what the tryout agent saw. */
  observation: z.string().max(OWNER_CHECK_OBSERVATION_MAX),
  /** The screenshot it took (an artifact id, a file path it printed, or a URL); null without one. */
  screenshot: z.string().max(2_000).nullable(),
  /** The pull request the run tried, when it tried one. */
  prNumber: z.int().positive().nullable(),
  /** The tryout session. */
  sessionId: Id,
  at: Timestamp,
});
export type OwnerCheckResult = z.infer<typeof OwnerCheckResult>;

/** One owner check of a project, as stored (event `factory.owner_check.updated`). */
export const OwnerCheck = z.object({
  id: Id,
  projectId: Id,
  text: z.string().trim().min(1).max(OWNER_CHECK_MAX),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** When a person removed it; null while it is in force. */
  removedAt: Timestamp.nullable(),
  /** Its last result; null until a run tried it (an edit clears it: the scenario changed). */
  last: OwnerCheckResult.nullable(),
});
export type OwnerCheck = z.infer<typeof OwnerCheck>;

/** A scenario's result as a run records it: which check, its number in the brief, the outcome. */
export const OwnerCheckRunResult = z.object({
  checkId: Id,
  /** Its number in the tryout's brief (1-based), the only name the builder ever gets. */
  number: z.int().positive(),
  state: OwnerCheckState,
  observation: z.string().max(OWNER_CHECK_OBSERVATION_MAX),
  screenshot: z.string().max(2_000).nullable(),
});
export type OwnerCheckRunResult = z.infer<typeof OwnerCheckRunResult>;

/**
 * Where a run is: `running` until the tryout agent submits, then `passed` (every scenario passed)
 * or `failed` (one or more failed); `error` when its session ended without results twice or could
 * not start.
 */
export const OwnerCheckRunState = z.enum(["running", "passed", "failed", "error"]);
export type OwnerCheckRunState = z.infer<typeof OwnerCheckRunState>;

/** One tryout run of a project's owner checks (event `factory.owner_check_run.updated`). */
export const OwnerCheckRun = z.object({
  id: Id,
  projectId: Id,
  /** `factory`: before a merge (a PR's head, or the release branch for a batch); `manual`: "Run owner checks" on a session or PR. */
  source: z.enum(["factory", "manual", "release"]),
  /** The factory work item whose PR it tried; null for a session's branch. */
  itemId: Id.nullable(),
  prNumber: z.int().positive().nullable(),
  /** The head commit it tried; a new head needs a new run. Null when unknown. */
  headSha: z.string().nullable(),
  /** The session whose branch it tried (manual runs on a session). */
  forSessionId: Id.nullable(),
  /** The tryout session; null until it started. */
  sessionId: Id.nullable(),
  /** The checks it was asked to try, in brief order (`number` is the index + 1). */
  checkIds: z.array(Id),
  state: OwnerCheckRunState,
  results: z.array(OwnerCheckRunResult),
  /** Why it ended in `error`, or a note while it runs. */
  detail: z.string().nullable(),
  /** When the factory nudged a tryout that ended its turn without results. */
  nudgedAt: Timestamp.nullable(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
});
export type OwnerCheckRun = z.infer<typeof OwnerCheckRun>;

/** `POST /api/projects/:id/owner-checks` and `PUT .../owner-checks/:checkId`. */
export const OwnerCheckWriteRequest = z.object({
  text: z.string().trim().min(1).max(OWNER_CHECK_MAX),
});
export type OwnerCheckWriteRequest = z.infer<typeof OwnerCheckWriteRequest>;

/** `POST /api/projects/:id/owner-checks/run`: run them on a session's branch or a work item's PR. */
export const OwnerCheckRunRequest = z
  .object({ sessionId: Id.optional(), itemId: Id.optional() })
  .refine((r) => Boolean(r.sessionId) !== Boolean(r.itemId), {
    message: "Give either sessionId or itemId",
  });
export type OwnerCheckRunRequest = z.infer<typeof OwnerCheckRunRequest>;

/** Most recent runs `OwnerChecksResponse.runs` lists (the newest first). */
export const OWNER_CHECK_RUNS_LISTED = 10;

/** `GET /api/projects/:id/owner-checks`: the checks in force and the latest runs. */
export const OwnerChecksResponse = z.object({
  checks: z.array(OwnerCheck),
  runs: z.array(OwnerCheckRun),
  /** Whether `.codeden/project.json` sets a `devServer`: without one the check is skipped. */
  devServer: z.boolean(),
});
export type OwnerChecksResponse = z.infer<typeof OwnerChecksResponse>;

/** One check written, edited or removed. */
export const OwnerCheckResponse = z.object({ check: OwnerCheck });
export type OwnerCheckResponse = z.infer<typeof OwnerCheckResponse>;

/** A run started by hand. */
export const OwnerCheckRunResponse = z.object({ run: OwnerCheckRun });
export type OwnerCheckRunResponse = z.infer<typeof OwnerCheckRunResponse>;

/** `factory_submit_owner_checks`: the tryout agent's results, one per scenario of its brief. */
export const OwnerChecksSubmission = z.object({
  results: z
    .array(
      z.object({
        number: z.int().positive().describe("The scenario's number in your brief"),
        state: OwnerCheckState.describe("pass when the app did what the scenario says"),
        observation: z
          .string()
          .trim()
          .min(1)
          .max(OWNER_CHECK_OBSERVATION_MAX)
          .describe(
            "One sentence of what you saw the app do. Describe the app's behaviour; don't repeat the scenario's wording.",
          ),
        screenshot: z
          .string()
          .trim()
          .min(1)
          .max(2_000)
          .optional()
          .describe(
            "The screenshot of this scenario: the File path or artifact id browser_screenshot printed",
          ),
      }),
    )
    .min(1)
    .max(MAX_OWNER_CHECKS),
});
export type OwnerChecksSubmission = z.infer<typeof OwnerChecksSubmission>;

/** The withheld text an observation is replaced with when it repeats a scenario's wording. */
export const OBSERVATION_WITHHELD =
  "(the tryout's note repeated the scenario's wording, so it is withheld; the screenshot shows what it saw)";

/**
 * An observation as the builder may read it: never the scenario's wording. One that contains the
 * scenario's text (ignoring case and spacing) is replaced with `OBSERVATION_WITHHELD`.
 */
export function builderSafeObservation(observation: string, scenario: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const said = norm(scenario).replace(/[.!]+$/, "");
  return said.length > 0 && norm(observation).includes(said) ? OBSERVATION_WITHHELD : observation;
}

/** Payloads of the owner checks' persisted events (projected into `factory_owner_check*`). */
export const OWNER_CHECK_EVENT_PAYLOADS = {
  /** A check written, edited (`last` cleared), removed (`removedAt`) or given a result; an upsert. */
  "factory.owner_check.updated": z.object({ check: OwnerCheck }),
  /** A tryout run started, nudged, finished or ended in error; an upsert. */
  "factory.owner_check_run.updated": z.object({ run: OwnerCheckRun }),
} as const;
