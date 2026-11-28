import {
  type BuilderScore,
  DRAIN_PER_PROJECT,
  DRAIN_UNAVAILABLE,
  type FactoryAdmitRequest,
  type FactoryAllowLargeChangeRequest,
  type FactoryAnalysisReport,
  type FactoryDecisionRequest,
  type FactoryDigest,
  type FactoryDismissRequest,
  type FactoryFileIssueRequest,
  type FactoryFinding,
  type FactoryHoldBy,
  type FactoryHoldRequest,
  type FactoryHoldResult,
  type FactoryItem,
  type FactoryItemResponse,
  type FactoryLesson,
  type FactoryLoop,
  type FactoryLoopState,
  type FactoryPlanRoundRequest,
  type FactoryReleaseRequest,
  type FactoryReleaseSnapshot,
  type FactoryReproductionReport,
  type FactoryRetryMode,
  type FactoryScorecard,
  type FactorySetTypeRequest,
  type FactorySpecDecisionRequest,
  type FactorySpotCheckRequest,
  type FactorySpotCheckResponse,
  type FactoryStatus,
  type FeatureMapResponse,
  type GitHubIssueRef,
  isFactoryMode,
  type KillSwitchMode,
  type KillSwitchResponse,
  type OwnerCheck,
  type OwnerCheckRun,
  type OwnerCheckRunRequest,
  type OwnerChecksResponse,
  type OwnerChecksSubmission,
  type ParkedIdea,
  type ParkIdeaRequest,
  type PlanResponse,
  type Project,
  type RawEventEnvelope,
  type ReviewVerdict,
  type ScorecardDays,
  type Session,
  type SetAutonomyModeRequest,
  type SetAutonomyModeResponse,
  type VisionResponse,
} from "@codeden/contracts";
import type { Db } from "../../db/client";
import type { EventStore } from "../../events/store";
import type { SettingsStore } from "../../settings-store";
import { badRequest, conflict, errorMessage, notFound } from "../errors";
import type { Exec } from "../exec";
import type { InboxService } from "../inbox-service";
import type { NoticeDraft } from "../orchestration/notices";
import { readFeatureMap, writeFeatureMap } from "../projects/feature-map-file";
import { readPlan, writePlan } from "../projects/plan-file";
import type { ProjectService } from "../projects/project-service";
import type { RunnerPort } from "../runner-port";
import type { SessionRepo } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";
import { flagAllowList, isAllowListNotice } from "./allow-lists";
import { ProviderAvailability, type ProviderRunnable } from "./availability";
import { buildBuilderScore } from "./builder-score";
import { SessionArchiver } from "./cleanup";
import type { FactoryContext } from "./context";
import { assertCanEnter, haltProject } from "./controls";
import * as decisions from "./decisions";
import { writeDigest } from "./digest";
import { advanceDrain, drainInboxId, drainStatus, startDrain } from "./drain";
import { fileFollowUp } from "./follow-ups";
import { dismissFollowUp } from "./follow-ups-held";
import type { FactoryGithub } from "./github-port";
import { holdIssue, releaseIssue } from "./hold";
import { itemCosts } from "./item-cost";
import { allowLargeChange } from "./large-change";
import { acceptLessonCheck } from "./lesson-checks";
import { asksPlainWords, forgetLesson, keepLessons } from "./lessons";
import { runTick } from "./loop";
import { MainCiReads } from "./main-ci";
import { PrFiles } from "./overlap";
import {
  addOwnerCheck,
  editOwnerCheck,
  ownerChecksView,
  removeOwnerCheck,
  submitOwnerChecks,
} from "./owner-checks";
import { startTryout } from "./owner-checks-run";
import {
  buildParkedIdea,
  parkIdea,
  setParkedIdeaAside,
  shownParkedIdeas,
  syncParkedIdeas,
} from "./parked-ideas";
import { reportReproduction, submitAnalysis } from "./pipeline";
import { localDay } from "./policy";
import { assertNoMergedPr } from "./pr-gone";
import { ProviderBackoffStore } from "./provider-backoffs";
import { approveRelease } from "./release";
import { revertsOnResume } from "./revert";
import { buildScorecard } from "./scorecard";
import { runScoutNow } from "./scout";
import { fileIssue, planRound, reportFindings } from "./scout-reports";
import {
  FactorySessions,
  isFactorySession,
  LENS_WORK_KEY_PREFIX,
  type ProviderChoice,
  SCOUT_WORK_KEY,
} from "./sessions";
import { SlotBoard } from "./slots";
import { assertSpecAllowsPr, decideSpec } from "./spec-approval";
import { decideSpotCheck, fileSpotCheckIssue } from "./spot-checks";
import { buildStatus } from "./status";
import { recordStop } from "./stops";
import { FactoryStore } from "./store";
import { answerProviderQuestion, recordDecision, unattendedSession } from "./unattended";
import { readVision, writeVision } from "./vision";

export interface FactoryOptions {
  /** Interval of the background tick (default 30 s). */
  tickMs?: number;
  /** Run the loop in the background (default true; tests drive `tick` by hand). */
  autoTick?: boolean;
  /** How long CI may take to start on a new head commit before it counts as never started (default 10 minutes). */
  ciGraceMs?: number;
  /**
   * How long the merge queue gives GitHub to work out the next pull request after a merge moved
   * the default branch, before it reads it again (default 2 s; 0 in tests: no waiting).
   */
  settleMs?: number;
  now?: () => Date;
}

export interface FactoryServiceDeps {
  db: Db;
  store: EventStore;
  projects: ProjectService;
  repo: SessionRepo;
  sessions: SessionService;
  runner: RunnerPort;
  usage: FactoryContext["usage"];
  inbox: InboxService;
  notify: (draft: NoticeDraft, wake?: boolean) => void;
  settings: SettingsStore;
  exec: Exec;
  github: FactoryGithub;
  /** The utility model, for the "Identify type" step (keywords decide without it). */
  complete?: (job: string, system: string, prompt: string) => Promise<string | null>;
  /** The session archive path (`WorktreeCleanup.archive`): hides it and removes its worktree. */
  archiveSession: (sessionId: string) => Promise<unknown>;
  /** Whether a session's work is being moved to another provider (`FactoryContext.switching`). */
  switching?: (sessionId: string) => boolean;
  options?: FactoryOptions;
  log?: (message: string) => void;
}

/** Resolve after `ms` (at once for 0); the timer never keeps the process alive. */
function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Project autonomy modes, the software factory and the dark factory (§10.1, experimental):
 * modes and limits, the vision, kill switches, the server-driven factory loop with its
 * pipelines and the dark factory's scout, daily digests and the status the factory panel and
 * its pipeline diagram show. The loop state is persisted, so a restart resumes where it stopped.
 */
export class FactoryService {
  readonly data: FactoryStore;
  readonly ctx: FactoryContext;
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Per project, the scout's and its area reviewers' reports, one at a time (`serializeReport`). */
  private readonly reportChains = new Map<string, Promise<unknown>>();
  /** Per project, the tick waiting for its turn on the chain (`tick`). */
  private readonly queuedTicks = new Map<string, Promise<FactoryLoop>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Archives finished work's sessions, one at a time, outside the tick chains. */
  readonly archiver: SessionArchiver;
  private interval: NodeJS.Timeout | undefined;
  private resumeTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: FactoryServiceDeps) {
    this.data = new FactoryStore(deps.db, deps.store);
    this.archiver = new SessionArchiver({
      repo: deps.repo,
      archive: deps.archiveSession,
      log: deps.log,
    });
    this.ctx = {
      store: this.data,
      github: deps.github,
      sessions: new FactorySessions({
        sessions: deps.sessions,
        repo: deps.repo,
        runner: deps.runner,
        availability: new ProviderAvailability({
          runner: deps.runner,
          rateLimits: () => deps.usage.rateLimitWindows?.() ?? [],
          now: deps.options?.now ?? (() => new Date()),
          backoffs: new ProviderBackoffStore(deps.db),
          log: deps.log,
        }),
        log: deps.log,
      }),
      projects: deps.projects,
      repo: deps.repo,
      usage: deps.usage,
      inbox: deps.inbox,
      notify: deps.notify,
      settings: deps.settings,
      exec: deps.exec,
      complete: deps.complete ?? (async () => null),
      archiveSessions: (ids) => this.archiver.push(ids),
      slots: new SlotBoard(),
      prFiles: new PrFiles(),
      upToDateRequired: new Set(),
      mainCi: new MainCiReads(),
      settle: () => wait(deps.options?.settleMs ?? 2_000),
      setKillSwitch: (projectId, on) => this.writeKillSwitch(projectId, on),
      switching: deps.switching,
      now: deps.options?.now ?? (() => new Date()),
      ciGraceMs: deps.options?.ciGraceMs ?? 10 * 60_000,
      log: deps.log,
    };
  }

  start(): void {
    this.unsubscribe ??= this.deps.store.subscribe((events) => this.onEvents(events));
    if (this.deps.options?.autoTick === false) return;
    const every = this.deps.options?.tickMs ?? 30_000;
    this.interval ??= setInterval(() => void this.tickAll(), every);
    this.interval.unref?.();
    // Resume loops persisted before a restart.
    this.resumeTimer ??= setTimeout(() => {
      this.resumeTimer = undefined;
      void this.tickAll();
    }, 1_000);
    this.resumeTimer.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = undefined;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /**
   * Run one loop step for a project (serialized per project). Calls made while a tick waits for
   * its turn share that tick, which reads the state when it starts: however often a busy factory
   * asks, at most one tick waits, so the agents' reports never queue behind a backlog of ticks.
   */
  tick(projectId: string): Promise<FactoryLoop> {
    const queued = this.queuedTicks.get(projectId);
    if (queued) return queued;
    const next = this.serialize(projectId, "tick", () => {
      this.queuedTicks.delete(projectId);
      // Its steps share one read of the project's items.
      return this.data.readOnce(projectId, () =>
        runTick(this.ctx, projectId, { digest: (p, l, day) => this.writeDigest(p, l, day) }),
      );
    });
    this.queuedTicks.set(projectId, next);
    return next;
  }

  /**
   * A person's **Check now**: providers backed off after a sign-in failure are tried again (the
   * person may have just signed in; providers are detected again in the background), then one
   * loop step runs.
   */
  checkNow(projectId: string): Promise<FactoryLoop> {
    this.ctx.sessions.recheckProviders();
    return this.tick(projectId);
  }

  /**
   * Run something that changes a project's loop record after the ticks and other changes
   * already queued for it, so two writers never overwrite each other's changes.
   */
  private serialize<T>(projectId: string, what: string, run: () => Promise<T> | T): Promise<T> {
    return this.enqueue(this.chains, projectId, what, run);
  }

  /**
   * Run one of the scout's or its area reviewers' reports after those already queued for the
   * project, never behind a tick: a tool call answers at once however long a tick takes, and a
   * tick that read the loop before keeps what it recorded (`keepScoutReports`).
   */
  private serializeReport<T>(projectId: string, what: string, run: () => Promise<T> | T) {
    return this.enqueue(this.reportChains, projectId, what, run);
  }

  private enqueue<T>(
    chains: Map<string, Promise<unknown>>,
    projectId: string,
    what: string,
    run: () => Promise<T> | T,
  ): Promise<T> {
    const prev = chains.get(projectId) ?? Promise.resolve(undefined);
    const next = prev.catch(() => undefined).then(run);
    chains.set(projectId, next);
    void next
      .catch((error: unknown) =>
        this.deps.log?.(`factory: ${what} ${projectId}: ${errorMessage(error)}`),
      )
      .finally(() => {
        if (chains.get(projectId) === next) chains.delete(projectId);
      });
    return next;
  }

  /** Tick every project in a factory mode (and loops that need to wind down). */
  async tickAll(): Promise<void> {
    let projects: ReturnType<FactoryServiceDeps["projects"]["list"]>;
    try {
      projects = this.deps.projects.list();
    } catch (error) {
      // Stopping: the database may already be closed.
      this.deps.log?.(`factory: listing projects: ${errorMessage(error)}`);
      return;
    }
    for (const p of projects) {
      if (!isFactoryMode(p.autonomyMode)) {
        const loop = this.data.loop(p.id);
        // A settled `stopped` loop with no drain has nothing left to wind down.
        const windingDown =
          loop && (loop.drain !== null || (loop.state !== "idle" && loop.state !== "stopped"));
        const hasFollowUpRuns = this.data.ownerChecks.followUpRuns(p.id).length > 0;
        if (!windingDown && !hasFollowUpRuns) continue;
      }
      await this.tick(p.id).catch(() => undefined);
    }
  }

  /** Schedule a tick soon (debounced), e.g. after a factory session changed. */
  soon(projectId: string, delayMs = 500): void {
    if (this.deps.options?.autoTick === false) return;
    if (this.timers.has(projectId)) return;
    const t = setTimeout(() => {
      this.timers.delete(projectId);
      void this.tick(projectId).catch(() => undefined);
    }, delayMs);
    t.unref?.();
    this.timers.set(projectId, t);
  }

  // ------------------------------------------------------------ modes, vision, switches

  status(projectId: string): Promise<FactoryStatus> {
    return buildStatus(this.ctx, projectId);
  }

  vision(projectId: string): VisionResponse {
    return readVision(this.deps.projects.get(projectId));
  }

  /**
   * Save the vision in the main checkout (the factory reads it from there), then, in a GitHub
   * project, commit it through a small PR (`codeden/vision`) so agent worktrees get it too.
   * A failed commit keeps the local save and reports `shareError`.
   */
  async putVision(projectId: string, contents: string): Promise<VisionResponse> {
    const project = this.deps.projects.get(projectId);
    const saved = writeVision(project, contents);
    if (project.kind !== "github" || !this.ctx.github.isGithubProject(projectId)) return saved;
    try {
      const path = project.visionPath.replaceAll("\\", "/").replace(/^\.\//, "");
      const pr = await this.ctx.github.shareVision(projectId, path, saved.contents);
      return { ...saved, pr, shareError: null };
    } catch (error) {
      this.deps.log?.(`factory: committing the vision: ${errorMessage(error)}`);
      return { ...saved, pr: null, shareError: errorMessage(error) };
    }
  }

  /** The project plan (§8.5); the template with `exists: false` when the file is missing. */
  plan(projectId: string): PlanResponse {
    return readPlan(this.deps.projects.get(projectId));
  }

  /**
   * Save the project plan (§8.5) in the main checkout, which briefs read it from, then, in a
   * GitHub project, commit it through a small PR of its own (`codeden/plan`), as the vision is.
   */
  async putPlan(projectId: string, contents: string): Promise<PlanResponse> {
    const project = this.deps.projects.get(projectId);
    const saved = writePlan(project, contents);
    if (project.kind !== "github" || !this.ctx.github.isGithubProject(projectId)) return saved;
    try {
      const pr = await this.ctx.github.shareVision(projectId, saved.path, saved.contents, "plan");
      return { ...saved, pr, shareError: null };
    } catch (error) {
      this.deps.log?.(`factory: committing the plan: ${errorMessage(error)}`);
      return { ...saved, pr: null, shareError: errorMessage(error) };
    }
  }

  /** The project's feature map (§8.5); the template with `exists: false` when the file is missing. */
  featureMap(projectId: string): FeatureMapResponse {
    return readFeatureMap(this.deps.projects.get(projectId));
  }

  /**
   * Save the feature map (§8.5) in the main checkout, which briefs read it from, then, in a GitHub
   * project, commit it through a small PR of its own (`codeden/feature-map`), as the plan is.
   */
  async putFeatureMap(projectId: string, contents: string): Promise<FeatureMapResponse> {
    const project = this.deps.projects.get(projectId);
    const saved = writeFeatureMap(project, contents);
    if (project.kind !== "github" || !this.ctx.github.isGithubProject(projectId)) return saved;
    try {
      const pr = await this.ctx.github.shareVision(
        projectId,
        saved.path,
        saved.contents,
        "feature-map",
      );
      return { ...saved, pr, shareError: null };
    } catch (error) {
      this.deps.log?.(`factory: committing the feature map: ${errorMessage(error)}`);
      return { ...saved, pr: null, shareError: errorMessage(error) };
    }
  }

  /**
   * Change the autonomy mode. The software and dark factory need a GitHub project, a vision
   * file and limits with a daily budget (in the request, or saved while already in a factory
   * mode); a request without them throws at once. The tuning in the request is merged into the
   * saved one after the ticks already queued, so a tick in flight never overwrites it.
   */
  setMode(projectId: string, req: SetAutonomyModeRequest): Promise<SetAutonomyModeResponse> {
    const project = this.deps.projects.get(projectId);
    const entering = isFactoryMode(req.mode);
    const wasFactory = isFactoryMode(project.autonomyMode);
    const limits = req.limits ?? project.factoryLimits;
    if (entering)
      assertCanEnter(this.ctx, project, { limitsSent: Boolean(req.limits), wasFactory, limits });
    const next = {
      ...project,
      autonomyMode: req.mode,
      factoryLimits: limits,
      updatedAt: new Date().toISOString(),
    } as Project;
    this.deps.store.append([
      { type: "project.updated", sessionId: null, payload: { project: next } },
    ]);
    const saved = this.serialize(projectId, "set mode", () => {
      const loop = this.data.loopOrNew(projectId, this.ctx.now());
      this.data.saveLoop({
        ...loop,
        tuning: {
          ...loop.tuning,
          ...req.tuning,
          ...(req.tuning?.autoMergeKinds
            ? { autoMergeKinds: { ...loop.tuning.autoMergeKinds, ...req.tuning.autoMergeKinds } }
            : {}),
        },
        ...(entering && !wasFactory
          ? {
              enabledAt: this.ctx.now().toISOString(),
              consecutiveFailures: 0,
              evidenceFailures: 0,
              pausedReason: null,
              state: "idle" as const,
            }
          : {}),
        ...(!entering
          ? { state: "idle" as const, drain: null, scout: { ...loop.scout, round: null } }
          : {}),
      });
    });
    this.soon(projectId);
    return saved.then(() => ({ projectId, mode: req.mode, limits, experimental: entering }));
  }

  /**
   * "Run scout now" (dark factory): start a scout round right away, skipping the interval and
   * the backlog threshold. Throws `scout_unavailable` (409) with the reason when it can't.
   */
  async runScout(projectId: string): Promise<FactoryLoop> {
    const loop = await this.serialize(projectId, "run scout", async () => {
      const project = this.deps.projects.get(projectId);
      const current = this.data.loopOrNew(projectId, this.ctx.now());
      return this.data.saveLoop(await runScoutNow(this.ctx, project, current));
    });
    this.soon(projectId);
    return loop;
  }

  /**
   * The project kill switch. On with `mode: "now"` (the default) stops the loop and every factory
   * session at once, ending a drain. On with `mode: "drain"` ("Finish current work, then stop",
   * `drain.ts`) takes on no new work and stops by itself once the work in flight has finished,
   * or after `drainLimitMin`. Off releases the switch and cancels a drain (Resume).
   */
  async setKillSwitch(
    projectId: string,
    on: boolean,
    opts: { mode?: KillSwitchMode; drainLimitMin?: number | null } = {},
  ): Promise<KillSwitchResponse> {
    if (on && opts.mode === "drain") return this.drain(projectId, opts.drainLimitMin);
    this.writeKillSwitch(projectId, on);
    if (on)
      return { on, stoppedSessions: await this.halt(projectId), draining: false, inFlight: 0 };
    const drained = this.deps.inbox.find(drainInboxId(projectId));
    if (drained?.status === "open") this.deps.inbox.close(drained, "resolved", { note: "resumed" });
    await this.serialize(projectId, "resume after kill", () => this.resumeAfterKill(projectId));
    return { on, stoppedSessions: [], draining: false, inFlight: 0 };
  }

  /**
   * The global kill switch (`settings.factory.killSwitch`): stops every project's loop at once.
   * A drain is per project, so `mode: "drain"` is refused (400 `drain_per_project`). A project
   * whose drain it cuts short keeps its own switch on, so releasing the global switch leaves it
   * stopped, as its user asked.
   */
  async setGlobalKillSwitch(
    on: boolean,
    mode: KillSwitchMode = "now",
  ): Promise<KillSwitchResponse> {
    if (on && mode === "drain") {
      throw badRequest(
        "Finishing current work before stopping is per project; the global switch stops every factory now",
        DRAIN_PER_PROJECT,
      );
    }
    const settings = this.deps.settings.update({ factory: { killSwitch: on } });
    this.deps.store.append([{ type: "settings.updated", sessionId: null, payload: { settings } }]);
    const stoppedSessions: string[] = [];
    for (const p of this.deps.projects.list()) {
      if (on) {
        if (this.data.loop(p.id)?.drain) this.writeKillSwitch(p.id, true);
        stoppedSessions.push(...(await this.halt(p.id)));
      } else if (!p.killSwitch && this.data.loop(p.id)) this.resumeAfterKill(p.id);
    }
    return { on, stoppedSessions, draining: false, inFlight: 0 };
  }

  /**
   * Resume a paused loop (resets the failure count). It also cancels a drain: the loop returns
   * to normal. Runs after the ticks already queued, so a tick in flight never brings either back.
   */
  resume(projectId: string): Promise<FactoryLoop> {
    const next = this.serialize(projectId, "resume", () => {
      const loop = this.data.loopOrNew(projectId, this.ctx.now());
      // Work whose revert merged goes back to its builder, also when CI never said green.
      revertsOnResume(this.ctx, projectId);
      return this.data.saveLoop({
        ...loop,
        state: "idle",
        pausedReason: null,
        consecutiveFailures: 0,
        evidenceFailures: 0,
        drain: null,
      });
    });
    const paused = this.deps.inbox.find(`inbox:factory-paused:${projectId}`);
    if (paused?.status === "open") this.deps.inbox.close(paused, "resolved", { note: "resumed" });
    this.soon(projectId);
    return next;
  }

  /** The loop for the PM's status digest; null outside the factory modes. */
  loopSummary(
    projectId: string,
  ): { loopState: FactoryLoopState; drainInFlight: number | null } | null {
    const project = this.deps.projects.get(projectId);
    if (!isFactoryMode(project.autonomyMode)) return null;
    const loop = this.data.loopOrNew(projectId, this.ctx.now());
    const killed = project.killSwitch || this.deps.settings.get().factory.killSwitch;
    return {
      loopState: killed ? "stopped" : loop.state,
      drainInFlight: drainStatus(this.ctx, projectId, loop)?.inFlight ?? null,
    };
  }

  item(projectId: string, itemId: string): FactoryItem {
    const item = this.data.item(itemId);
    if (!item || item.projectId !== projectId)
      throw notFound(`No factory item ${itemId}`, "item_not_found");
    return item;
  }

  /** An item with what it cost so far (`FactoryItemResponse`; `item-cost.ts`). */
  async itemResponse(projectId: string, item: FactoryItem): Promise<FactoryItemResponse> {
    const limits = this.deps.projects.get(projectId).factoryLimits;
    const costs = await itemCosts(this.ctx, projectId, limits, [item]);
    return { item, cost: costs.get(item.id) ?? null };
  }

  /**
   * The scorecard (`scorecard.ts`): how each builder and reviewer, by provider and model, did on
   * the work that finished in the last `days`.
   */
  scorecard(projectId: string, days: ScorecardDays): Promise<FactoryScorecard> {
    return buildScorecard(this.ctx, projectId, days);
  }

  /**
   * The builder score (`builder-score.ts`): how each builder model did on the factory's real
   * work in the last `days`, across every project or one.
   */
  builderScore(days: ScorecardDays, projectId?: string): Promise<BuilderScore> {
    return buildBuilderScore(this.ctx, days, projectId);
  }

  /** Write today's digest now (the loop writes one per day on its own). */
  async digestNow(projectId: string): Promise<FactoryDigest> {
    const project = this.deps.projects.get(projectId);
    const loop = this.data.loopOrNew(projectId, this.ctx.now());
    return this.writeDigest(project, loop, localDay(this.ctx.now()));
  }

  // ------------------------------------------------------------ decisions (UI, PM)

  /** Let an ignored issue from an untrusted author in (never merged automatically). */
  async admit(
    projectId: string,
    req: FactoryAdmitRequest,
    by: decisions.DecidedBy,
  ): Promise<FactoryItem> {
    const item = await decisions.admit(this.ctx, projectId, req, by);
    this.soon(projectId);
    return item;
  }

  /** Correct the type of an item that hasn't started. */
  async setType(
    projectId: string,
    req: FactorySetTypeRequest,
    by: decisions.DecidedBy,
  ): Promise<FactoryItem> {
    const item = await decisions.setType(this.ctx, projectId, req, by);
    this.soon(projectId);
    return item;
  }

  /**
   * Run a stopped item again: its open PR back to review (`rereview`, the default while it is
   * open), or a fresh attempt from the first step (`rebuild`).
   */
  retry(
    projectId: string,
    itemId: string,
    mode?: FactoryRetryMode,
    by: decisions.DecidedBy = "user",
  ): FactoryItem {
    const item = decisions.retry(this.ctx, projectId, itemId, mode, by);
    this.soon(projectId);
    return item;
  }

  /**
   * Hold an open issue out of the loop (`hold.ts`): the hold label goes on it and the reason is
   * recorded with the loop, so it runs after the ticks already queued.
   */
  async hold(
    projectId: string,
    req: FactoryHoldRequest,
    by: FactoryHoldBy,
  ): Promise<FactoryHoldResult> {
    const res = await this.serialize(projectId, "hold", () =>
      holdIssue(this.ctx, projectId, req, by),
    );
    this.soon(projectId);
    return res;
  }

  /** Release a held issue: the label comes off and the loop picks it up on its next tick. */
  async release(
    projectId: string,
    req: FactoryReleaseRequest,
    by: FactoryHoldBy,
  ): Promise<FactoryHoldResult> {
    const res = await this.serialize(projectId, "release", () =>
      releaseIssue(this.ctx, projectId, req, by),
    );
    this.soon(projectId);
    return res;
  }

  /**
   * Before a factory builder or reviewer is stopped with a reason: record the stop on its item, so
   * the item stops as that call rather than as a failure (`stops.ts`). `stop` null takes it back
   * (the session couldn't be stopped). Null when the session works on no factory item.
   */
  recordStop(
    projectId: string,
    sessionId: string,
    stop: { reason: string; by: FactoryHoldBy } | null,
  ): FactoryItem | null {
    return recordStop(this.ctx, projectId, sessionId, stop);
  }

  /**
   * "File issue" (and "File now" on the scout's held list): file one review follow-up of a merged
   * item as an issue, labelled and linked to its PR (or link it to the open issue with the same
   * title). Filing it again changes nothing.
   */
  fileFollowUp(projectId: string, itemId: string, index: number): Promise<FactoryItem> {
    return this.serialize(projectId, "file follow-up", () =>
      fileFollowUp(
        this.ctx,
        this.deps.projects.get(projectId),
        this.item(projectId, itemId),
        index,
      ),
    );
  }

  /**
   * "Dismiss" on the scout's held list: the review follow-up leaves it without an issue (the
   * item keeps it, so "File issue" can still file it). 409 `follow_up_filed` once it has one.
   */
  dismissFollowUp(projectId: string, itemId: string, index: number): Promise<FactoryItem> {
    return this.serialize(projectId, "dismiss follow-up", () =>
      dismissFollowUp(this.ctx, this.item(projectId, itemId), index),
    );
  }

  /**
   * A person's spot-check of a merge (`spot-checks.ts`): Looks good, or Found a problem with a
   * note, optionally filed as a follow-up issue. Nothing waits on it.
   */
  decideSpotCheck(
    projectId: string,
    itemId: string,
    req: FactorySpotCheckRequest,
  ): Promise<FactorySpotCheckResponse> {
    return this.serialize(projectId, "spot-check", () =>
      decideSpotCheck(this.ctx, this.deps.projects.get(projectId), itemId, req),
    );
  }

  /** "File issue": the follow-up issue of a spot-check problem recorded without one. */
  fileSpotCheckIssue(projectId: string, itemId: string): Promise<FactorySpotCheckResponse> {
    return this.serialize(projectId, "spot-check issue", () =>
      fileSpotCheckIssue(this.ctx, this.deps.projects.get(projectId), itemId),
    );
  }

  /** Dismiss a failed item without an open PR: it is rejected with the reason. */
  dismiss(
    projectId: string,
    itemId: string,
    req: FactoryDismissRequest,
    by: decisions.DecidedBy,
  ): FactoryItem {
    const item = decisions.dismiss(this.ctx, projectId, itemId, req, by);
    this.soon(projectId);
    return item;
  }

  /**
   * Approve a feature's spec that waits for approval, or ask for changes to it; the loop sends the
   * decision to the builder (`spec-approval.ts`).
   */
  async decideSpec(
    projectId: string,
    itemId: string,
    req: FactorySpecDecisionRequest,
  ): Promise<FactoryItem> {
    const item = await decideSpec(this.ctx, projectId, itemId, req);
    this.soon(projectId);
    return item;
  }

  /** `factory_park_idea`: the scout keeps a good idea it isn't filing (`parked-ideas.ts`). */
  parkIdea(session: Session, req: ParkIdeaRequest) {
    return parkIdea(this.ctx, session, req);
  }

  /** Copy parked ideas to the Ideas repository now (the loop does it on its ticks). */
  syncParkedIdeas(): Promise<void> {
    return syncParkedIdeas(this.ctx);
  }

  /** The ideas the Parked ideas list shows for a project. */
  parkedIdeas(projectId: string): ParkedIdea[] {
    this.deps.projects.get(projectId);
    return shownParkedIdeas(this.ctx, projectId);
  }

  /** "Build it": file the idea as a factory issue in this project. */
  async buildParkedIdea(projectId: string, id: string): Promise<ParkedIdea> {
    this.deps.projects.get(projectId);
    const idea = await buildParkedIdea(this.ctx, projectId, id);
    this.soon(projectId);
    return idea;
  }

  /** "Not now": hide the idea and label its Ideas issue `someday`. */
  setParkedIdeaAside(projectId: string, id: string): ParkedIdea {
    this.deps.projects.get(projectId);
    return setParkedIdeaAside(this.ctx, projectId, id);
  }

  /** Yes to a suggested check: file the issue that builds it (the usual pipeline takes over). */
  acceptLessonCheck(projectId: string, lessonId: string): Promise<GitHubIssueRef> {
    this.deps.projects.get(projectId);
    return acceptLessonCheck(this.ctx, projectId, lessonId);
  }

  /** Forget one of the project's lessons: it leaves the briefs and is never learned again. */
  forgetLesson(projectId: string, lessonId: string): FactoryLesson {
    this.deps.projects.get(projectId);
    return forgetLesson(this.ctx, projectId, lessonId);
  }

  /**
   * Release the batch into the default branch (release mode, `release.ts`). Only the gates in
   * the loop's release snapshot allow it; a conflict leaves the batch for a person to merge.
   */
  approveRelease(projectId: string): Promise<FactoryReleaseSnapshot> {
    return this.serialize(projectId, "release approve", () => approveRelease(this.ctx, projectId));
  }

  // ------------------------------------------------------------ owner checks

  /** The owner checks editor: the checks in force, the latest runs, whether a dev server is set. */
  ownerChecks(projectId: string): OwnerChecksResponse {
    return ownerChecksView(this.ctx, this.deps.projects.get(projectId));
  }

  /** Write a new owner check. */
  addOwnerCheck(projectId: string, text: string): OwnerCheck {
    this.deps.projects.get(projectId);
    return addOwnerCheck(this.ctx, projectId, text);
  }

  /** Change an owner check's wording (its last result is cleared). */
  editOwnerCheck(projectId: string, checkId: string, text: string): OwnerCheck {
    this.deps.projects.get(projectId);
    return editOwnerCheck(this.ctx, projectId, checkId, text);
  }

  /** Remove an owner check. */
  removeOwnerCheck(projectId: string, checkId: string): OwnerCheck {
    this.deps.projects.get(projectId);
    return removeOwnerCheck(this.ctx, projectId, checkId);
  }

  /**
   * "Run owner checks" on a session's branch or a work item's PR: the same tryout as before a
   * merge. A run of a work item's current head counts for its `owner_checks` merge check.
   */
  async runOwnerChecks(projectId: string, req: OwnerCheckRunRequest): Promise<OwnerCheckRun> {
    const run = await this.startManualTryout(projectId, req);
    // The loop follows the run up (nudge, close, archive the tryout), in any autonomy mode.
    this.soon(projectId);
    return run;
  }

  private async startManualTryout(
    projectId: string,
    req: OwnerCheckRunRequest,
  ): Promise<OwnerCheckRun> {
    const project = this.deps.projects.get(projectId);
    if (req.itemId) {
      const item = this.item(projectId, req.itemId);
      if (!item.pr) throw conflict("The work item has no pull request yet", "no_pull_request");
      const pr = await this.ctx.github.prDetails(projectId, item.pr.number);
      return startTryout(this.ctx, project, {
        source: "manual",
        item,
        prNumber: pr.ref.number,
        headSha: pr.headSha,
        forSessionId: null,
        branch: pr.headBranch,
        fetch: true,
        label: `pull request #${pr.ref.number}`,
      });
    }
    const session = this.deps.repo.get(req.sessionId as string);
    if (session.projectId !== projectId) throw notFound("No such session in this project");
    if (!session.branch) throw conflict("The session has no branch to try", "no_branch");
    return startTryout(this.ctx, project, {
      source: "manual",
      item: null,
      prNumber: null,
      headSha: null,
      forSessionId: session.id,
      branch: session.branch,
      fetch: false,
      label: `the branch \`${session.branch}\` (session "${session.title ?? session.id}")`,
    });
  }

  /** `factory_submit_owner_checks`: the tryout agent's results. */
  submitOwnerChecks(session: Session, submission: OwnerChecksSubmission) {
    const res = submitOwnerChecks(this.ctx, session.id, submission);
    if (session.projectId) this.soon(session.projectId);
    return res;
  }

  // ------------------------------------------------------------ agents' reports (tools)

  /** `factory_report_reproduction`; the answer is the builder's next step. */
  async reportReproduction(session: Session, report: FactoryReproductionReport) {
    const res = await reportReproduction(this.ctx, session, report);
    if (session.projectId) this.soon(session.projectId);
    return res;
  }

  /** `factory_submit_analysis`; the answer is the builder's next step. */
  async submitAnalysis(session: Session, report: FactoryAnalysisReport) {
    const res = await submitAnalysis(this.ctx, session, report);
    if (session.projectId) this.soon(session.projectId);
    return res;
  }

  /** `factory_plan_round`: the scout's review areas for this round; the next tick starts them. */
  async planRound(session: Session, req: FactoryPlanRoundRequest) {
    const projectId = session.projectId ?? "";
    const res = await this.serializeReport(projectId, "plan round", () =>
      planRound(this.ctx, session, req),
    );
    this.soon(projectId);
    return res;
  }

  /** `factory_report_findings`: an area reviewer's findings. */
  async reportFindings(session: Session, findings: FactoryFinding[]) {
    const projectId = session.projectId ?? "";
    const res = await this.serializeReport(projectId, "findings", () =>
      reportFindings(this.ctx, session, findings),
    );
    this.soon(projectId);
    return res;
  }

  /** `factory_file_issue`: the scout files one piece of work. */
  async fileIssue(session: Session, req: FactoryFileIssueRequest) {
    const projectId = session.projectId ?? "";
    const res = await this.serializeReport(projectId, "file issue", () =>
      fileIssue(this.ctx, session, req),
    );
    this.soon(projectId);
    return res;
  }

  /**
   * Whether new work can start on `provider` now and, if not, why and what fixes it ("Gemini
   * CLI is too old (0.36.0, needs 0.68.0+): run `npm install -g @google/gemini-cli@latest`"):
   * not offered by the runner, not installed, too old to run, signed out, at its usage limit or
   * backed off after a provider failure (§10.1, Provider availability).
   */
  providerRunnable(provider: string): ProviderRunnable {
    return this.ctx.sessions.runnable(provider);
  }

  /**
   * The providers the runner offers, each with whether new work can start on it now and, if not,
   * why and the fix: what a PM or the orchestrator needs to pick a provider without trying each.
   */
  providerChoices(): Promise<ProviderChoice[]> {
    return this.ctx.sessions.choices();
  }

  /**
   * `providerRunnable` for a person's Retry (§11.1): without the factory's back-off after its own
   * sessions failed on the provider, and detected afresh before it says no.
   */
  providerRunnableNow(provider: string): Promise<ProviderRunnable> {
    return this.ctx.sessions.runnableNow(provider);
  }

  /** Whether a session is a factory builder (it may report a reproduction or analysis). */
  isBuilder(sessionId: string): boolean {
    const s = this.deps.repo.find(sessionId)?.session;
    if (!s?.projectId || !isFactorySession(s)) return false;
    return this.data.items(s.projectId, ["building"]).some((i) => i.builderSessionId === s.id);
  }

  /**
   * Before `create_pull_request`: throws `409 spec_not_approved` for a factory builder whose spec
   * waits for a person's approval or is being revised at their request (`spec-approval.ts`), and
   * `409 pr_merged` for the agent of an item whose PR already merged (`pr-gone.ts`).
   */
  assertMayOpenPr(sessionId: string): void {
    const s = this.deps.repo.find(sessionId)?.session;
    if (!s || !isFactorySession(s)) return;
    assertSpecAllowsPr(this.ctx, s);
    assertNoMergedPr(this.ctx, s);
  }

  /**
   * Whether the factory handles `session` at a usage limit by its own rules, so CodeDen does not
   * move its work to another provider (§8.1, `WorkerLimitSwitch`). Every factory session but a
   * builder that has no pull request yet: a reviewer is replaced on another provider by the
   * factory itself, and work with a pull request would continue on a new branch, away from it.
   */
  keepsOwnLimitRules(session: Session): boolean {
    if (!isFactorySession(session)) return false;
    if (!session.projectId) return true;
    const item = this.data.itemForSession(session.projectId, session.id);
    return !item || item.builderSessionId !== session.id || item.pr !== null;
  }

  /**
   * A builder's work moved to `next` on another provider (§8.1): the item follows it, and the
   * session it leaves becomes an earlier one. A switch is no failed attempt, so nothing else of
   * the item changes (`attempts`, nudges, notes).
   */
  builderMoved(from: Session, next: Session): void {
    if (!from.projectId) return;
    const item = this.data.itemForSession(from.projectId, from.id);
    if (!item || item.builderSessionId !== from.id) return;
    this.data.updateItem(item.id, (i) => ({
      ...i,
      builderSessionId: next.id,
      builderProvider: next.provider,
      earlierSessionIds: [...new Set([...i.earlierSessionIds, from.id])],
    }));
    this.soon(from.projectId);
  }

  /** Whether a session is the dark factory's scout. */
  isScout(sessionId: string): boolean {
    const s = this.deps.repo.find(sessionId)?.session;
    return s !== undefined && isFactorySession(s) && s.workKey === SCOUT_WORK_KEY;
  }

  /** Whether a session is one of the scout's area reviewers (lenses). */
  isLens(sessionId: string): boolean {
    const s = this.deps.repo.find(sessionId)?.session;
    return s !== undefined && isFactorySession(s) && s.workKey.startsWith(LENS_WORK_KEY_PREFIX);
  }

  /**
   * `factory_submit_review`. The verdict is settled (or refused, which throws) before this
   * returns; its lessons are kept once GitHub shows who commented on the work (`keepLessons`).
   */
  submitReview(
    session: Session,
    verdict: ReviewVerdict,
  ): Promise<Omit<decisions.ReviewOutcome, "forward">> {
    const { forward, item, ...res } = decisions.submitReview(this.ctx, session, verdict);
    // A verdict that came after a revise round started: its findings go to the author.
    if (forward) {
      this.ctx.sessions
        .message(forward.sessionId, forward.text)
        .catch((error: unknown) =>
          this.deps.log?.(`factory: late review to ${forward.sessionId}: ${errorMessage(error)}`),
        );
    }
    if (session.projectId) this.soon(session.projectId);
    return keepLessons(this.ctx, item, verdict.lessons).then((kept) =>
      decisions.withKeptLessons(res, kept),
    );
  }

  /** `factory_allow_large_change`: the PM lets an item over the size limit merge. */
  allowLargeChange(projectId: string, req: FactoryAllowLargeChangeRequest): FactoryItem {
    const item = allowLargeChange(this.ctx, projectId, req);
    this.soon(projectId);
    return item;
  }

  /** `factory_record_decision`: a decision an unattended agent made instead of asking. */
  recordDecision(session: Session, req: FactoryDecisionRequest) {
    return recordDecision(this.ctx, { projectId: session.projectId, sessionId: session.id }, req);
  }

  /** True when nobody answers this session's questions (dark factory PM or factory agent). */
  isUnattended(sessionId: string): boolean {
    return unattendedSession(this.ctx, sessionId) !== undefined;
  }

  /** The project of this session asks for plain words (`Project.plainWords`). */
  asksPlainWords(sessionId: string): boolean {
    const projectId = this.ctx.repo.find(sessionId)?.session.projectId;
    return projectId ? asksPlainWords(this.ctx, projectId) : false;
  }

  // ------------------------------------------------------------ internals

  private halt(projectId: string): Promise<string[]> {
    return haltProject(this.ctx, projectId);
  }

  /**
   * Begin a drain, or change the time limit of the one running. With nothing in flight the loop
   * stops at once. A kill switch that is on already has nothing left to drain (it stays on).
   * Outside the factory modes, or while the global kill switch is on, there is nothing a drain
   * could do: 409 `drain_unavailable`, with the reason.
   */
  private async drain(
    projectId: string,
    limitMin: number | null | undefined,
  ): Promise<KillSwitchResponse> {
    const project = this.deps.projects.get(projectId);
    if (!isFactoryMode(project.autonomyMode)) {
      throw conflict(
        "Only the software and dark factory finish their current work before stopping",
        DRAIN_UNAVAILABLE,
      );
    }
    if (this.deps.settings.get().factory.killSwitch) {
      throw conflict(
        "The global kill switch is on: every factory is stopped already",
        DRAIN_UNAVAILABLE,
      );
    }
    if (project.killSwitch) {
      return { on: true, stoppedSessions: [], draining: false, inFlight: 0 };
    }
    const res = await this.serialize(projectId, "drain", async () => {
      const started = await startDrain(this.ctx, projectId, limitMin);
      const loop = this.data.saveLoop(await advanceDrain(this.ctx, project, started.loop));
      return { loop, stoppedSessions: started.stoppedSessions };
    });
    this.soon(projectId);
    const draining = res.loop.drain !== null;
    return {
      on: !draining,
      stoppedSessions: res.stoppedSessions,
      draining,
      inFlight: drainStatus(this.ctx, projectId, res.loop)?.inFlight ?? 0,
    };
  }

  /** Write the project's kill switch (a `project.updated` event) when it changes. */
  private writeKillSwitch(projectId: string, on: boolean): void {
    const project = this.deps.projects.get(projectId);
    if (project.killSwitch === on) return;
    const next = { ...project, killSwitch: on, updatedAt: new Date().toISOString() } as Project;
    this.deps.store.append([
      { type: "project.updated", sessionId: null, payload: { project: next } },
    ]);
  }

  /** The switch is off: a stopped loop runs again and a drain is cancelled (a pause stays). */
  private resumeAfterKill(projectId: string): void {
    const loop = this.data.loopOrNew(projectId, this.ctx.now());
    if (loop.state === "stopped" || loop.state === "draining" || loop.drain) {
      const state = loop.state === "paused" ? "paused" : "idle";
      this.data.saveLoop({ ...loop, state, drain: null });
    }
    this.soon(projectId);
  }

  private writeDigest(project: Project, loop: FactoryLoop, day: string): Promise<FactoryDigest> {
    return writeDigest(this.ctx, this.deps.inbox, project, loop, day);
  }

  private onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (e.type === "agent.item.started") {
        if ((e.payload as { item?: { kind?: string } }).item?.kind !== "user_question") continue;
        // After the current append: answering appends events of its own.
        setImmediate(
          () =>
            void answerProviderQuestion(
              this.ctx,
              (id, req) => this.deps.sessions.respond(id, req),
              e,
            ),
        );
      } else if (isAllowListNotice(e)) {
        // After the current append: it appends the item's change and an inbox item.
        setImmediate(() => {
          try {
            flagAllowList(this.ctx, e);
          } catch (error) {
            this.deps.log?.(`factory: allow-list warning: ${errorMessage(error)}`);
          }
        });
      } else if (e.type === "session.updated") {
        const { session } = e.payload as { session: Session };
        if (session.projectId && isFactorySession(session)) this.soon(session.projectId);
      } else if (e.type.startsWith("pr.")) {
        const { pr } = e.payload as { pr: { projectId: string } };
        if (this.inFactoryMode(pr.projectId)) this.soon(pr.projectId);
      }
    }
  }

  private inFactoryMode(projectId: string): boolean {
    try {
      return isFactoryMode(this.deps.projects.get(projectId).autonomyMode);
    } catch {
      return false;
    }
  }
}
