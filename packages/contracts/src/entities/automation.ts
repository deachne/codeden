import { z } from "zod";
import {
  AutonomyLevel,
  ErrorInfo,
  Id,
  ProviderId,
  QuietHours,
  ReasoningEffort,
  Timestamp,
} from "../common";
import { OverlapPolicy, workFields } from "../work";

/** Events an automation can be triggered by (§10). */
export const AutomationEventName = z.enum([
  "session.finished",
  "session.failed",
  "session.needs_input",
  "pr.opened",
  "pr.merged",
  "pr.checks_failed",
  "pr.review_requested",
  "issue.opened",
  "issue.labeled",
  "issue.commented",
]);
export type AutomationEventName = z.infer<typeof AutomationEventName>;

/** When an automation fires. */
export const AutomationTrigger = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cron"),
    /** Cron expression (croner syntax). */
    expression: z.string().min(1),
    /** IANA timezone; defaults to the project's timezone. */
    timezone: z.string().optional(),
  }),
  z.object({
    type: z.literal("event"),
    event: AutomationEventName,
    filter: z
      .object({
        labels: z.array(z.string()).optional(),
        branches: z.array(z.string()).optional(),
        authors: z.array(z.string()).optional(),
      })
      .optional(),
  }),
  z.object({ type: z.literal("manual") }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

/**
 * How the PM's issue triage applies a decision (§10): labels per decision, whether to comment
 * and close, and whether a `ready` issue may start a session without asking (assisted mode and
 * above only; otherwise the user gets a "Should I take this on?" inbox decision).
 */
export const TriagePolicy = z.object({
  labels: z
    .object({
      ready: z.array(z.string().min(1)).default(["triage:ready"]),
      needs_info: z.array(z.string().min(1)).default(["needs-info"]),
      unsafe: z.array(z.string().min(1)).default(["triage:unsafe"]),
      out_of_scope: z.array(z.string().min(1)).default(["out-of-scope"]),
      duplicate: z.array(z.string().min(1)).default(["duplicate"]),
    })
    .prefault({}),
  /** Post a short comment explaining the decision. */
  comment: z.boolean().default(true),
  /** Close duplicates and out-of-scope issues as "not planned". */
  closeRejected: z.boolean().default(false),
  /** Start a session for `ready` issues without asking (never in `manual` projects). */
  autoStart: z.boolean().default(false),
  /** Provider, model and autonomy for sessions started from triage. */
  provider: ProviderId.optional(),
  model: z.string().optional(),
  autonomy: AutonomyLevel.optional(),
});
export type TriagePolicy = z.infer<typeof TriagePolicy>;

/** The most steps a recipe may have (a recipe is a short list, not a program). */
export const RECIPE_MAX_STEPS = 20;

/**
 * One step of a recipe (§10): start an agent session, tell the PM, or pause and ask the owner.
 * `id` is stable within the recipe (the run state keeps its answers under it). Prompts,
 * messages and questions take the same `{{placeholders}}` as other actions.
 */
export const RecipeStep = z.discriminatedUnion("type", [
  z.object({
    id: z.string().trim().min(1).max(40),
    type: z.literal("start_session"),
    prompt: z.string().min(1),
    title: z.string().optional(),
    provider: ProviderId.optional(),
    model: z.string().optional(),
    effort: ReasoningEffort.optional(),
    autonomy: AutonomyLevel.optional(),
  }),
  z.object({
    id: z.string().trim().min(1).max(40),
    type: z.literal("message_pm"),
    message: z.string().min(1),
  }),
  z.object({
    id: z.string().trim().min(1).max(40),
    type: z.literal("ask_owner"),
    /** What the owner is asked, in plain words, e.g. "OK to go on?". Answered Yes or No. */
    question: z.string().trim().min(1).max(500),
  }),
]);
export type RecipeStep = z.infer<typeof RecipeStep>;

/** A recipe's steps: 1 to {@link RECIPE_MAX_STEPS}, each with its own id. */
export const RecipeSteps = z
  .array(RecipeStep)
  .min(1)
  .max(RECIPE_MAX_STEPS)
  .refine((steps) => new Set(steps.map((s) => s.id)).size === steps.length, {
    message: "Every step needs its own id",
  });
export type RecipeSteps = z.infer<typeof RecipeSteps>;

/** What an automation does when it fires. */
export const AutomationAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start_session"),
    /** Prompt template (Markdown, `{{placeholders}}` filled from the trigger context). */
    prompt: z.string().min(1),
    title: z.string().optional(),
    provider: ProviderId.optional(),
    model: z.string().optional(),
    effort: ReasoningEffort.optional(),
    autonomy: AutonomyLevel.optional(),
  }),
  z.object({
    type: z.literal("message_pm"),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal("triage"),
    policy: TriagePolicy.optional(),
    /** Extra guidance for the PM, appended to the triage request. */
    instructions: z.string().optional(),
  }),
  /**
   * A recipe: steps CodeDen runs in order. A step can pause and ask the owner; the run keeps
   * its place across restarts (`AutomationRun.recipe`). Database automations only.
   */
  z.object({
    type: z.literal("recipe"),
    steps: RecipeSteps,
  }),
]);
export type AutomationAction = z.infer<typeof AutomationAction>;

/** Which projects an automation applies to. */
export const AutomationTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project"), projectId: Id }),
  z.object({ type: z.literal("all_projects") }),
]);
export type AutomationTarget = z.infer<typeof AutomationTarget>;

/** Safety rails on automation runs (§10). */
export const AutomationGuards = z.object({
  /** What a trigger does while previous work with the same workKey is still going (§8.4). */
  overlapPolicy: OverlapPolicy.default("skip-if-running"),
  maxConcurrent: z.int().positive().default(1),
  maxPerDay: z.int().positive().nullable().default(null),
  quietHours: QuietHours.nullable().default(null),
  /** Run once for missed schedules after downtime. */
  catchUpMissed: z.boolean().default(false),
});
export type AutomationGuards = z.infer<typeof AutomationGuards>;

/** Who created a database automation (§10). */
export const AutomationCreator = z.enum(["user", "pm", "import"]);
export type AutomationCreator = z.infer<typeof AutomationCreator>;

/**
 * The permission level a person approved for an automation's sessions (§10): the level its
 * definition asked for when they switched it on, or `default` when it named none (the
 * project's default level).
 */
export const ApprovedAutonomy = z.union([AutonomyLevel, z.literal("default")]);
export type ApprovedAutonomy = z.infer<typeof ApprovedAutonomy>;

/** An automation: trigger + action + target + guards. Off by default. */
export const Automation = z.object({
  id: Id,
  name: z.string().min(1),
  description: z.string().nullable(),
  enabled: z.boolean().default(false),
  /** Where the definition lives. */
  source: z.enum(["builtin", "global_file", "project_file", "database"]),
  /** Template this was created from, if any. */
  templateId: z.string().nullable(),
  trigger: AutomationTrigger,
  action: AutomationAction,
  target: AutomationTarget,
  guards: AutomationGuards.prefault({}),
  /**
   * Work key of its runs (§8.4), e.g. `automation:security-audit`; may contain
   * `{{placeholders}}` from the trigger (`automation:ci-fix:{{pr.number}}`). Defaults to
   * `automation:<template id or name slug>`.
   */
  workKey: z.string().min(1).max(200).optional(),
  /**
   * Who created a database automation: the user in the UI (`user`, the default when absent),
   * a PM through `create_automation` (`pm`), or an import of shared files (`import`).
   */
  createdBy: AutomationCreator.optional(),
  /**
   * The permission level a person last approved by switching it on (or creating or saving it
   * on). Runs nobody starts by hand never get a higher one; a change in its file or by a PM
   * to what it does switches it off until someone approves again. Absent until then.
   */
  approvedAutonomy: ApprovedAutonomy.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Automation = z.infer<typeof Automation>;

/**
 * Frontmatter of an automation template file (Markdown + YAML; the body is the prompt).
 * Lives in `~/.codeden/automations/` or a repo's `.codeden/automations/`.
 */
export const AutomationTemplateFrontmatter = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: AutomationTrigger,
  provider: ProviderId.optional(),
  model: z.string().optional(),
  autonomy: AutonomyLevel.optional(),
  guards: AutomationGuards.partial().optional(),
});
export type AutomationTemplateFrontmatter = z.infer<typeof AutomationTemplateFrontmatter>;

export const AutomationRunStatus = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatus>;

/** Where one step of a recipe run stands. */
export const RecipeStepStatus = z.enum([
  "pending",
  "running",
  /** An "ask me" step waiting for the owner's Yes or No. */
  "waiting",
  "done",
  "failed",
  /** Ended the run on purpose: the owner said No, or the session was stopped. */
  "stopped",
]);
export type RecipeStepStatus = z.infer<typeof RecipeStepStatus>;

/** What one step of a recipe run did (§10). */
export const RecipeStepRun = z.object({
  stepId: z.string(),
  status: RecipeStepStatus,
  /** The session a "start a session" step started. */
  sessionId: Id.nullable().default(null),
  /** The question card of an "ask me" step. */
  inboxItemId: Id.nullable().default(null),
  /** The owner's answer to an "ask me" step. */
  answer: z.enum(["yes", "no"]).nullable().default(null),
  /** A short plain-words result: the session's summary, or why the step ended. */
  result: z.string().max(2000).nullable().default(null),
  startedAt: Timestamp.nullable().default(null),
  finishedAt: Timestamp.nullable().default(null),
});
export type RecipeStepRun = z.infer<typeof RecipeStepRun>;

/**
 * The durable state of a recipe run (§10): the step it is on and what each step did. A step is
 * saved as `running` before it acts and `done` when it finishes, so after a restart the run
 * picks up at the first step that isn't done and never repeats one that is.
 */
export const RecipeRunState = z.object({
  /** Index of the step the run is on; equals `steps.length` once every step is done. */
  current: z.int().min(0),
  /**
   * A person started the run ("Run now" in Automations), so its sessions get the permission
   * levels the recipe asks for; any other run is capped at the level a person approved.
   */
  byPerson: z.boolean().default(false),
  steps: z.array(RecipeStepRun),
});
export type RecipeRunState = z.infer<typeof RecipeRunState>;

/** One execution of an automation. Every run is a normal session or PM turn (§10). */
export const AutomationRun = z
  .object({
    id: Id,
    automationId: Id,
    projectId: Id.nullable(),
    status: AutomationRunStatus,
    triggeredBy: z.enum(["cron", "event", "manual", "catch_up"]),
    /** Who/why/what (§8.4): startedBy, purpose, workKey, scope, progress. */
    ...workFields,
    /** Set when `status` is `skipped`. */
    skipReason: z
      .enum([
        "overlap",
        "concurrency",
        "quiet_hours",
        "daily_cap",
        "disabled",
        "skipped_by_pm",
        "conflict_skip",
        /** An issue-intake run in a software- or dark-factory project: the factory loop owns intake. */
        "factory_intake",
      ])
      .nullable(),
    sessionId: Id.nullable(),
    /**
     * The issue an issue-triggered run is about. A triage run stays `running` until the PM's
     * `report_triage` for this issue arrives.
     */
    issueNumber: z.int().positive().nullable().optional(),
    /** A recipe run's progress, step by step; absent for every other run. */
    recipe: RecipeRunState.nullable().optional(),
    startedAt: Timestamp,
    finishedAt: Timestamp.nullable(),
    error: ErrorInfo.nullable(),
  })
  .refine((run) => (run.status === "skipped") === (run.skipReason !== null), {
    message: "skipReason is required exactly when status is skipped",
    path: ["skipReason"],
  });
export type AutomationRun = z.infer<typeof AutomationRun>;
