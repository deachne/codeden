import {
  type Automation,
  type AutomationRun,
  type AutonomyLevel,
  type InboxItem,
  type Project,
  type RecipeAnswerResponse,
  type RecipeRunState,
  type RecipeStep,
  type RunAutomationResponse,
  recipeQuestionInboxId,
  type Session,
} from "@codeden/contracts";
import { badRequest, conflict, errorMessage } from "../errors";
import type { InboxService } from "../inbox-service";
import type { OrchestrationService } from "../orchestration/orchestration-service";
import type { SessionRepo } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";
import { renderTemplate, type TemplateVars } from "./prompt";
import {
  completeStep,
  endStep,
  firstUnfinished,
  newRecipeState,
  patchStep,
  RECIPE_WAITING_TEXT,
  stepLabel,
} from "./recipe-state";
import { ACTIVE_RUN, type RunStore } from "./runs";
import { automationSessionRequest } from "./session-request";

/** What a recipe run needs to know about its automation and project. */
export interface RecipeContext {
  automation: Automation;
  project: Project;
  vars: TemplateVars;
}

export interface RecipeDeps {
  runs: RunStore;
  sessions: SessionService;
  repo: SessionRepo;
  inbox: InboxService;
  orchestration: () => OrchestrationService;
  /** The automation and project of a run; undefined when either is gone or no longer a recipe. */
  context: (run: AutomationRun) => RecipeContext | undefined;
  /** A session step's permission level: what it asks for, capped at what a person approved. */
  autonomy: (
    ctx: RecipeContext,
    asked: AutonomyLevel | undefined,
    byPerson: boolean,
  ) => AutonomyLevel | undefined;
  /** The run status a session's status stands for (the same mapping every automation run uses). */
  sessionRunStatus: (session: Session) => AutomationRun["status"];
  /** Follow a session's events: its run advances when the session finishes. */
  track: (sessionId: string, runId: string) => void;
  untrack: (sessionId: string) => void;
  now: () => Date;
  log?: (message: string) => void;
}

/** The status a step's session ended in, in a `RecipeStep`'s own words. */
type SessionOutcome =
  | { kind: "going" }
  | { kind: "done"; result: string | null }
  | { kind: "failed"; message: string }
  | { kind: "stopped" };

/**
 * Runs a recipe (§10): the steps of a run, one after the other, on top of the automation
 * machinery (the same run row, session start, PM messages and inbox cards). The run row's
 * `recipe` state is saved before a step acts and again when it ends, so after a restart
 * {@link resume} picks up at the first step that isn't over and never repeats one that is.
 *
 * Work on one run is serialised, so a session finishing and the owner answering at the same
 * moment can't advance it twice.
 */
export class RecipeRunner {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: RecipeDeps) {}

  /** Start a recipe run whose guards already passed. */
  async begin(
    ctx: RecipeContext,
    run: AutomationRun,
    byPerson: boolean,
  ): Promise<RunAutomationResponse> {
    const action = ctx.automation.action;
    if (action.type !== "recipe") throw new Error("not a recipe");
    const saved = this.deps.runs.save({
      ...run,
      status: "running",
      recipe: newRecipeState(action.steps, byPerson),
    });
    const latest = await this.serial(saved.id, () => this.advance(saved.id));
    return { status: "started", run: latest, sessionId: latest.sessionId };
  }

  /** Look at a run again: after a session event, a restart or a change of its question. */
  poke(runId: string): Promise<AutomationRun> {
    return this.serial(runId, () => this.advance(runId));
  }

  /**
   * Pick up every recipe run that was going when the server stopped. A step that is over stays
   * over; the first one that isn't is looked at again by {@link advance}.
   */
  async resume(): Promise<void> {
    for (const run of this.deps.runs.activeRecipes()) {
      await this.poke(run.id).catch((error) =>
        this.deps.log?.(`recipes: resuming ${run.id}: ${errorMessage(error)}`),
      );
    }
  }

  /** The owner's Yes or No to an "ask me" step's card. */
  answer(itemId: string, answer: "yes" | "no"): Promise<RecipeAnswerResponse> {
    const asked = this.deps.inbox.get(itemId);
    if (asked.kind !== "recipe_question" || !asked.automationRunId) {
      throw badRequest("Not a recipe question", "not_recipe_question");
    }
    const runId = asked.automationRunId;
    return this.serial(runId, async () => {
      const current = this.deps.inbox.get(itemId);
      if (current.status !== "open")
        throw conflict("The question was already answered", "resolved");
      const run = this.deps.runs.get(runId);
      const at = waitingIndex(run, itemId);
      if (!run.recipe || at === -1) {
        throw conflict("The recipe is no longer waiting for this answer", "not_waiting");
      }
      const now = this.deps.now().toISOString();
      const number = at + 1;
      const next =
        answer === "yes"
          ? completeStep(run.recipe, at, now, { answer, result: "You said yes" })
          : endStep(run.recipe, at, "stopped", `You said no at step ${number}`, now, { answer });
      // The run first, then the card: a card left open for a step that is over does no harm.
      if (answer === "yes") {
        this.deps.runs.save({ ...run, recipe: next, progress: progress("You said yes", now) });
      } else {
        this.deps.runs.save({
          ...run,
          status: "cancelled",
          recipe: next,
          finishedAt: now,
          progress: progress(`You said no at step ${number}: the recipe stopped`, now),
        });
      }
      const item = this.deps.inbox.close(current, "resolved", { answer });
      const after = answer === "yes" ? await this.advance(runId) : this.deps.runs.get(runId);
      return { item, run: after };
    });
  }

  /**
   * An "ask me" card was closed some other way (dismissed, or closed without an answer): the
   * recipe can't go on without one, so it stops.
   */
  cardClosed(item: InboxItem): Promise<void> | undefined {
    if (item.kind !== "recipe_question" || item.status === "open" || !item.automationRunId) {
      return undefined;
    }
    const runId = item.automationRunId;
    return this.serial(runId, async () => {
      const run = this.deps.runs.find(runId);
      if (!run || waitingIndex(run, item.id) === -1) return;
      this.stop(run, "The question was closed without an answer");
    }).then(() => undefined);
  }

  // ---------------------------------------------------------------- steps

  /** Take the run as far as it can go: until it waits on a session or the owner, or ends. */
  private async advance(runId: string): Promise<AutomationRun> {
    let run = this.deps.runs.get(runId);
    try {
      for (;;) {
        if (!ACTIVE_RUN.includes(run.status) || !run.recipe) return run;
        const ctx = this.deps.context(run);
        const steps = ctx?.automation.action.type === "recipe" ? ctx.automation.action.steps : null;
        if (!ctx || !steps) return this.fail(run, "The recipe was deleted while it was running");
        const state = run.recipe;
        const index = Math.min(state.current, firstUnfinished(state));
        if (index >= steps.length) return this.finish(run);
        const step = steps[index];
        const stepRun = state.steps[index];
        if (
          !step ||
          !stepRun ||
          stepRun.stepId !== step.id ||
          steps.length !== state.steps.length
        ) {
          return this.fail(run, "The recipe was changed while it was running, so it stopped");
        }
        const next = await this.runStep(ctx, run, step, index);
        if (next === "wait") return this.deps.runs.get(runId);
        run = next;
      }
    } catch (error) {
      this.deps.log?.(`recipes: run ${runId} failed: ${errorMessage(error)}`);
      return this.fail(this.deps.runs.get(runId), errorMessage(error));
    }
  }

  /** One step: the run afterwards, or `wait` when it now waits on a session or the owner. */
  private async runStep(
    ctx: RecipeContext,
    run: AutomationRun,
    step: RecipeStep,
    index: number,
  ): Promise<AutomationRun | "wait"> {
    switch (step.type) {
      case "start_session":
        return this.sessionStep(ctx, run, step, index);
      case "message_pm":
        return this.messageStep(ctx, run, step, index);
      case "ask_owner":
        return this.askStep(ctx, run, step, index);
    }
  }

  private async messageStep(
    ctx: RecipeContext,
    run: AutomationRun,
    step: Extract<RecipeStep, { type: "message_pm" }>,
    index: number,
  ): Promise<AutomationRun> {
    const state = this.begun(run, index);
    const text = renderTemplate(step.message, ctx.vars);
    await this.deps.orchestration().sendToRole(
      "pm",
      ctx.project.id,
      {
        text: `Recipe "${ctx.automation.name}", ${stepLabel(step, index, state.steps.length)}:\n\n${text}`,
        attachments: [],
      },
      "queue",
      "automation",
    );
    const now = this.deps.now().toISOString();
    const fresh = this.deps.runs.get(run.id);
    return this.deps.runs.save({
      ...fresh,
      recipe: completeStep(fresh.recipe ?? state, index, now, { result: "Message sent to the PM" }),
    });
  }

  private async sessionStep(
    ctx: RecipeContext,
    run: AutomationRun,
    step: Extract<RecipeStep, { type: "start_session" }>,
    index: number,
  ): Promise<AutomationRun | "wait"> {
    const state = run.recipe as RecipeRunState;
    const sessionId = state.steps[index]?.sessionId;
    if (sessionId) return this.followSession(run, sessionId, index);

    const started = this.begun(run, index);
    const request = (decision?: { resolution: "wait" }) =>
      automationSessionRequest({
        automation: ctx.automation,
        project: ctx.project,
        run,
        action: step,
        vars: ctx.vars,
        autonomy: this.deps.autonomy(ctx, step.autonomy, state.byPerson),
        decision,
      });
    let res = await this.deps.sessions.start(request());
    // Other work on the same key: wait for it, like a recipe that is already under way should.
    if (res.status === "conflict")
      res = await this.deps.sessions.start(request({ resolution: "wait" }));
    if (res.status !== "started" && res.status !== "queued") {
      return this.fail(
        run,
        "Another session is already doing this work, so the step couldn't start",
      );
    }
    const saved = this.deps.runs.save({
      ...this.deps.runs.get(run.id),
      status: "running",
      sessionId: res.sessionId,
      recipe: patchStep(started, index, { sessionId: res.sessionId }),
    });
    this.deps.repo.update(res.sessionId, (s) => ({ ...s, automationRunId: saved.id }));
    this.deps.track(res.sessionId, saved.id);
    return this.followSession(saved, res.sessionId, index);
  }

  /** A session step that has a session: done, failed, stopped, or still going (wait). */
  private followSession(
    run: AutomationRun,
    sessionId: string,
    index: number,
  ): AutomationRun | "wait" {
    const outcome = this.outcome(sessionId);
    const state = run.recipe as RecipeRunState;
    const now = this.deps.now().toISOString();
    switch (outcome.kind) {
      case "going":
        // Make sure a restarted server follows it again.
        this.deps.track(sessionId, run.id);
        return "wait";
      case "done":
        this.deps.untrack(sessionId);
        return this.deps.runs.save({
          ...run,
          recipe: completeStep(state, index, now, { result: outcome.result }),
        });
      case "failed":
        this.deps.untrack(sessionId);
        return this.fail(run, outcome.message);
      case "stopped":
        this.deps.untrack(sessionId);
        return this.stop(run, "The session was stopped, so the recipe stopped");
    }
  }

  private outcome(sessionId: string): SessionOutcome {
    const session = this.deps.repo.find(sessionId)?.session;
    if (!session) return { kind: "failed", message: "The session this step started is gone" };
    const status = this.deps.sessionRunStatus(session);
    switch (status) {
      case "queued":
      case "running":
        return { kind: "going" };
      case "completed":
        return { kind: "done", result: session.result?.summary?.slice(0, 2000) ?? null };
      case "cancelled":
        return { kind: "stopped" };
      default:
        return { kind: "failed", message: session.result?.summary ?? "The session failed" };
    }
  }

  private async askStep(
    ctx: RecipeContext,
    run: AutomationRun,
    step: Extract<RecipeStep, { type: "ask_owner" }>,
    index: number,
  ): Promise<AutomationRun | "wait"> {
    const state = run.recipe as RecipeRunState;
    const question = renderTemplate(step.question, ctx.vars);
    // A dark factory never answers for the owner and nobody waits on them there: stop and flag.
    if (ctx.project.autonomyMode === "dark_factory") {
      this.flagDarkFactory(run, ctx, question);
      return this.fail(
        run,
        `Step ${index + 1} asks for your OK ("${question}"), but nobody can be asked in a dark factory, so the recipe stopped`,
      );
    }
    const id = recipeQuestionInboxId(run.id, step.id);
    const existing = this.deps.inbox.find(id);
    if (existing && existing.status !== "open") {
      // The card was closed while the step still waited (a restart in between): follow it.
      return this.stop(run, "The question was closed without an answer");
    }
    if (existing && state.steps[index]?.status === "waiting") return "wait"; // already asked
    if (!existing)
      this.deps.inbox.put(this.card(id, run, ctx, question, index, state.steps.length));
    const now = this.deps.now().toISOString();
    const waiting = patchStep(state, index, {
      status: "waiting",
      inboxItemId: id,
      startedAt: state.steps[index]?.startedAt ?? now,
    });
    this.deps.runs.save({
      ...run,
      status: "running",
      sessionId: null,
      recipe: waiting,
      progress: progress(`${RECIPE_WAITING_TEXT}${question}`, now),
    });
    return "wait";
  }

  // ---------------------------------------------------------------- endings

  private finish(run: AutomationRun): AutomationRun {
    const now = this.deps.now().toISOString();
    const total = run.recipe?.steps.length ?? 0;
    return this.deps.runs.save({
      ...run,
      status: "completed",
      finishedAt: now,
      progress: progress(`All ${total} steps are done`, now),
    });
  }

  private fail(run: AutomationRun, message: string): AutomationRun {
    const now = this.deps.now().toISOString();
    return this.deps.runs.save({
      ...run,
      status: "failed",
      finishedAt: now,
      error: { message },
      recipe: this.endCurrent(run, "failed", message, now),
    });
  }

  private stop(run: AutomationRun, message: string): AutomationRun {
    const now = this.deps.now().toISOString();
    return this.deps.runs.save({
      ...run,
      status: "cancelled",
      finishedAt: now,
      progress: progress(message, now),
      recipe: this.endCurrent(run, "stopped", message, now),
    });
  }

  private endCurrent(
    run: AutomationRun,
    status: "failed" | "stopped",
    message: string,
    now: string,
  ): RecipeRunState | null | undefined {
    const state = run.recipe;
    if (!state) return state;
    const at = firstUnfinished(state);
    return at >= state.steps.length ? state : endStep(state, at, status, message, now);
  }

  // ---------------------------------------------------------------- helpers

  /** The step marked running (saved before it acts), and the run's state with it. */
  private begun(run: AutomationRun, index: number): RecipeRunState {
    const state = run.recipe as RecipeRunState;
    const now = this.deps.now().toISOString();
    const stepRun = state.steps[index];
    const next = patchStep(state, index, {
      status: "running",
      startedAt: stepRun?.startedAt ?? now,
    });
    const ctx = this.deps.context(run);
    const steps = ctx?.automation.action.type === "recipe" ? ctx.automation.action.steps : [];
    const step = steps[index];
    this.deps.runs.save({
      ...run,
      status: "running",
      recipe: next,
      progress: step ? progress(stepLabel(step, index, steps.length), now) : run.progress,
    });
    return next;
  }

  private card(
    id: string,
    run: AutomationRun,
    ctx: RecipeContext,
    question: string,
    index: number,
    total: number,
  ): InboxItem {
    const now = this.deps.now().toISOString();
    return {
      id,
      kind: "recipe_question",
      status: "open",
      priority: "normal",
      notify: "needs_you",
      title: question,
      body: `Recipe "${ctx.automation.name}", step ${index + 1} of ${total}. Say Yes to carry on, or No to stop the recipe here.`,
      projectId: ctx.project.id,
      sessionId: null,
      threadId: null,
      itemId: null,
      requestId: null,
      issue: null,
      pr: null,
      automationRunId: run.id,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolution: null,
    };
  }

  /** The note that says a dark factory's recipe wanted an answer nobody can give. */
  private flagDarkFactory(run: AutomationRun, ctx: RecipeContext, question: string): void {
    const now = this.deps.now().toISOString();
    this.deps.inbox.put({
      id: `inbox:recipe-dark:${run.id}`,
      kind: "message",
      status: "open",
      priority: "high",
      notify: "needs_you",
      title: `Recipe "${ctx.automation.name}" stopped: it needs your OK`,
      body: `It asked "${question}", but this project runs without anyone to ask, and CodeDen never answers for you. Run the recipe again from a project you drive yourself, or take the question out.`,
      projectId: ctx.project.id,
      sessionId: null,
      threadId: null,
      itemId: null,
      requestId: null,
      issue: null,
      pr: null,
      automationRunId: run.id,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolution: null,
    });
  }

  /** Run `work` after everything already queued for the run. */
  private serial<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const before = this.queues.get(runId) ?? Promise.resolve();
    const result = before.then(work);
    const tail = result.catch(() => undefined);
    this.queues.set(runId, tail);
    void tail.then(() => {
      if (this.queues.get(runId) === tail) this.queues.delete(runId);
    });
    return result;
  }
}

function progress(text: string, at: string): AutomationRun["progress"] {
  return { text, at };
}

/** The index of the step waiting on this card, or -1. */
function waitingIndex(run: AutomationRun, itemId: string): number {
  if (!run.recipe || !ACTIVE_RUN.includes(run.status)) return -1;
  return run.recipe.steps.findIndex((s) => s.status === "waiting" && s.inboxItemId === itemId);
}
