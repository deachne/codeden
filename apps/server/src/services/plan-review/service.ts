import { createHash, randomUUID } from "node:crypto";
import {
  PLAN_REVIEW_WORK_KEY_PREFIX,
  type PlanOpinionRow,
  type PlanReview,
  type PlanReviewDecision,
  type PlanReviewer,
  type PlanReviewOptions,
  type PlanReviewRow,
  type RawEventEnvelope,
  type Session,
  type StartPlanReviewRequest,
  StartSessionRequest,
  type StartSessionResponse,
  type UserInput,
} from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import { badRequest, conflict, errorMessage, notFound } from "../errors";
import { readVision } from "../factory/vision";
import { readPlan } from "../projects/plan-file";
import { openPlanner } from "../projects/planner";
import type { ProjectService } from "../projects/project-service";
import type { RunnerPort } from "../runner-port";
import type { SessionRepo } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";
import { applyMessage, reviewerBrief, settlerMessage } from "./brief";
import { planReviewOptions, type ReadyChoice } from "./options";
import type { PlanReviewStore } from "./store";

/**
 * Second opinions on a plan (§8.5). The owner presses **Get second opinions**, picks the
 * reviewers and a cost cap, and presses **Go**: one read-only agent session per reviewer reads
 * the same plan on its own. When they are all done (or stopped for going over the cap), the
 * Planner checks every point against the code and settles a table. The owner accepts or rejects
 * each row; accepted rows go back to the Planner, whose `propose_plan` saves them through the
 * normal plan save path. Nothing here starts on its own, and Approve plan never depends on it.
 */

export interface PlanReviewDeps {
  events: Pick<EventStore, "subscribe">;
  store: PlanReviewStore;
  projects: Pick<ProjectService, "get">;
  repo: Pick<SessionRepo, "find" | "list" | "turnCount" | "rootItems">;
  sessions: Pick<SessionService, "start" | "send" | "stop">;
  runner: Pick<RunnerPort, "providers">;
  /** Whether each provider can take new work now (`FactoryService.providerChoices`). */
  choices: () => Promise<ReadyChoice[]>;
  /** Priced ledger turns of these sessions (`UsageService.turnsOf`). */
  turnsOf: (ids: ReadonlySet<string>) => Array<{ costUsd: number }>;
  /** Archive a finished reviewer session and clean up its worktree. */
  archive?: (sessionId: string) => Promise<unknown>;
  log?: (message: string) => void;
}

/** Session statuses in which a reviewer's turn is over and it waits for nothing. */
const FINISHED_OK = new Set(["idle", "completed"]);
const FINISHED_BAD = new Set(["failed", "interrupted", "stopped"]);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const open = (r: PlanReview) => r.status === "reviewing" || r.status === "settling";
const sum = (rows: Array<{ costUsd: number }>) =>
  Math.round(rows.reduce((n, r) => n + r.costUsd, 0) * 10_000) / 10_000;

export class PlanReviewService {
  private unsubscribe: (() => void) | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PlanReviewDeps) {}

  /** Follow the reviewers of open reviews; picks up where a restart left off. */
  start(): void {
    this.unsubscribe = this.deps.events.subscribe((events) => {
      if (events.some((e) => this.concerns(e))) this.enqueue();
    });
    this.enqueue();
  }

  stop(): void {
    this.unsubscribe?.();
  }

  /** Look at every open review's reviewers now; resolves once that is done. */
  refresh(): Promise<void> {
    this.enqueue();
    return this.chain;
  }

  // ------------------------------------------------------------------ reads

  /** The project's newest review, or none. */
  latest(projectId: string): PlanReview | null {
    this.deps.projects.get(projectId);
    return this.deps.store.latest(projectId) ?? null;
  }

  /** What the box before Go shows. Needs a plan and an open Planner session. */
  options(projectId: string): PlanReviewOptions {
    const { planner } = this.prerequisites(projectId);
    // `choices` is async (it may detect afresh); the box reads the last known state.
    return planReviewOptions({
      providers: this.deps.runner.providers(),
      choices: this.lastChoices,
      plannerProvider: planner.provider,
    });
  }

  private lastChoices: ReadyChoice[] = [];

  /** `options`, with provider readiness read afresh. */
  async optionsNow(projectId: string): Promise<PlanReviewOptions> {
    this.lastChoices = await this.deps.choices();
    return this.options(projectId);
  }

  /** Whether the session is a reviewer of a review still at work. */
  isReviewer(sessionId: string): boolean {
    return this.reviewOf(sessionId, "reviewing") !== undefined;
  }

  /** Whether the session is the Planner of a review waiting for its table. */
  isSettler(sessionId: string): boolean {
    return this.deps.store
      .open()
      .some((r) => r.status === "settling" && r.settlerSessionId === sessionId);
  }

  // ------------------------------------------------------------------- Go

  /** "Go": start the ticked reviewers, each read-only on the same plan. Only a person calls this. */
  async begin(projectId: string, req: StartPlanReviewRequest): Promise<PlanReview> {
    const { project, planner, plan } = this.prerequisites(projectId);
    if (
      this.deps.store.latest(project.id) &&
      open(this.deps.store.latest(project.id) as PlanReview)
    ) {
      throw conflict(
        "Second opinions are already being gathered for this plan",
        "plan_review_running",
      );
    }
    const options = await this.optionsNow(project.id);
    const picks = [...new Set(req.reviewers)].map((id) => {
      const c = options.candidates.find((x) => x.providerId === id);
      if (!c) throw badRequest(`${id} can't review a plan`, "unknown_provider");
      if (!c.ready)
        throw conflict(`${c.displayName} ${c.reason ?? "isn't ready"}`, "provider_unavailable");
      return c;
    });
    const id = randomUUID();
    const now = new Date().toISOString();
    const brief = reviewerBrief({
      projectName: project.name,
      vision: (() => {
        const v = readVision(project);
        return v.exists ? v.contents : null;
      })(),
      plan: plan.contents,
    });
    const reviewers: PlanReviewer[] = [];
    let firstError: unknown;
    for (const [n, pick] of picks.entries()) {
      try {
        const started = await this.deps.sessions.start(
          StartSessionRequest.parse({
            projectId: project.id,
            role: "agent",
            provider: pick.providerId,
            // A reviewer reads and runs checks; it never edits (§11.2). Only providers that
            // enforce it are offered.
            autonomy: "read_only",
            purpose: "Give a second opinion on the project plan",
            workKey: `${PLAN_REVIEW_WORK_KEY_PREFIX}${id}:${n + 1}`,
            title: `Second opinion on the plan: ${pick.displayName}`.slice(0, 200),
            startedBy: { kind: "user" },
            input: { text: brief, attachments: [], from: "codeden" } satisfies UserInput,
          }),
        );
        reviewers.push({
          sessionId: sessionOf(started),
          providerId: pick.providerId,
          displayName: pick.displayName,
          status: "running",
          text: null,
          costUsd: 0,
        });
      } catch (error) {
        firstError ??= error;
        this.deps.log?.(`plan review: ${pick.displayName} did not start: ${errorMessage(error)}`);
      }
    }
    if (reviewers.length === 0)
      throw firstError ?? conflict("No reviewer could start", "plan_review_failed");
    return this.deps.store.save({
      id,
      projectId: project.id,
      status: "reviewing",
      planSha256: sha256(plan.contents),
      capUsd: req.capUsd,
      reviewers,
      settlerSessionId: planner.id,
      rows: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  // ------------------------------------------------------------ agent tools

  /** `submit_plan_review`: a reviewer hands over its findings. */
  submitReview(sessionId: string, text: string): PlanReview {
    const review = this.reviewOf(sessionId, "reviewing");
    if (!review) throw conflict("This session isn't reviewing a plan right now", "not_a_reviewer");
    return this.deps.store.save({
      ...review,
      reviewers: review.reviewers.map((r) => (r.sessionId === sessionId ? { ...r, text } : r)),
    });
  }

  /** `submit_plan_opinions`: the Planner hands over the settled table. */
  submitOpinions(sessionId: string, rows: PlanOpinionRow[]): PlanReview {
    const review = this.deps.store.open().find((r) => r.settlerSessionId === sessionId);
    if (!review) throw conflict("No plan review is waiting for you", "not_the_settler");
    if (review.status === "reviewing") {
      throw conflict(
        "The reviewers are still at work: wait for their reports",
        "reviewers_running",
      );
    }
    return this.deps.store.save({
      ...review,
      status: "ready",
      rows: rows.map((r): PlanReviewRow => ({ ...r, id: randomUUID(), decision: "pending" })),
    });
  }

  // ----------------------------------------------------------------- owner

  /** The owner's Accept or Reject on one row. */
  decide(projectId: string, rowId: string, decision: PlanReviewDecision): PlanReview {
    const review = this.ready(projectId);
    if (!review.rows.some((r) => r.id === rowId)) throw notFound("No such row", "row_not_found");
    return this.deps.store.save({
      ...review,
      rows: review.rows.map((r) => (r.id === rowId ? { ...r, decision } : r)),
    });
  }

  /** "Add accepted to plan": the Planner folds the accepted rows in and saves with `propose_plan`. */
  async apply(projectId: string): Promise<PlanReview> {
    const review = this.ready(projectId);
    const accepted = review.rows.filter((r) => r.decision === "accepted");
    if (accepted.length === 0) throw conflict("Accept at least one row first", "nothing_accepted");
    await this.tell(review.settlerSessionId, applyMessage(accepted));
    return this.deps.store.save({ ...review, status: "applied" });
  }

  /** Stop gathering opinions (or drop a table the owner doesn't want). */
  async cancel(projectId: string): Promise<PlanReview> {
    const review = this.deps.store.latest(projectId);
    if (!review || !(open(review) || review.status === "ready")) {
      throw conflict("There is nothing to cancel", "no_plan_review");
    }
    for (const r of review.reviewers.filter((x) => x.status === "running")) {
      await this.deps.sessions.stop(r.sessionId).catch(() => undefined);
    }
    return this.deps.store.save({
      ...review,
      status: "cancelled",
      reviewers: review.reviewers.map((r) =>
        r.status === "running" ? { ...r, status: "failed" as const } : r,
      ),
    });
  }

  // ------------------------------------------------------------- following

  private concerns(e: RawEventEnvelope): boolean {
    if (e.type !== "session.updated" && e.type !== "agent.usage.updated") return false;
    const id =
      e.type === "session.updated" ? (e.payload as { session: Session }).session.id : e.sessionId;
    return (
      id !== null && this.deps.store.open().some((r) => r.reviewers.some((x) => x.sessionId === id))
    );
  }

  private enqueue(): void {
    this.chain = this.chain
      .then(() => this.advanceAll())
      .catch((error) => this.deps.log?.(`plan review: ${errorMessage(error)}`));
  }

  private async advanceAll(): Promise<void> {
    for (const review of this.deps.store.open()) {
      if (review.status === "reviewing") await this.advance(review.id);
    }
  }

  /**
   * Bring a review in line with its reviewers' sessions: one that finished is `done` (with its
   * last reply when it never submitted a report), one that ended badly is `failed`, and one that
   * spent more than the cap is stopped (`stopped_cap`; what it handed over stays). When none
   * is running the Planner is asked to settle the table.
   */
  private async advance(reviewId: string): Promise<void> {
    const review = this.deps.store.get(reviewId);
    if (review?.status !== "reviewing") return;
    const finished: string[] = [];
    const reviewers: PlanReviewer[] = [];
    for (const r of review.reviewers) {
      if (r.status !== "running") {
        reviewers.push(r);
        continue;
      }
      const next = await this.follow(review, r);
      if (next.status !== "running") finished.push(r.sessionId);
      reviewers.push(next);
    }
    if (finished.length === 0) return;
    const allDone = reviewers.every((r) => r.status !== "running");
    // A report handed over while a reviewer was being stopped must not be lost: read it afresh.
    const fresh = this.deps.store.get(reviewId) ?? review;
    const updated = this.deps.store.save({
      ...fresh,
      reviewers: reviewers.map((r) => ({
        ...r,
        text: fresh.reviewers.find((x) => x.sessionId === r.sessionId)?.text ?? r.text,
      })),
      status: allDone ? "settling" : "reviewing",
    });
    for (const id of finished) void this.deps.archive?.(id)?.catch?.(() => undefined);
    if (allDone) await this.askToSettle(updated);
  }

  private async follow(review: PlanReview, r: PlanReviewer): Promise<PlanReviewer> {
    const session = this.deps.repo.find(r.sessionId)?.session;
    const costUsd = sum(this.deps.turnsOf(new Set([r.sessionId])));
    if (!session) return { ...r, status: "failed", costUsd };
    const text = r.text ?? this.lastReply(session);
    if (FINISHED_OK.has(session.status) && this.deps.repo.turnCount(session.id) > 0) {
      return { ...r, status: "done", text, costUsd };
    }
    if (FINISHED_BAD.has(session.status)) {
      return { ...r, status: "failed", text, costUsd };
    }
    if (costUsd > review.capUsd) {
      await this.deps.sessions.stop(session.id).catch(() => undefined);
      return { ...r, status: "stopped_cap", text, costUsd };
    }
    return { ...r, costUsd };
  }

  private lastReply(session: Session): string | null {
    const replies = this.deps.repo.rootItems(session, ["assistant_message"], 5);
    for (const item of replies.reverse()) {
      if (item.kind === "assistant_message" && item.text.trim()) return item.text;
    }
    return null;
  }

  private async askToSettle(review: PlanReview): Promise<void> {
    try {
      await this.tell(review.settlerSessionId, settlerMessage(review));
    } catch (error) {
      this.deps.log?.(
        `plan review: the Planner could not be asked to settle: ${errorMessage(error)}`,
      );
      this.deps.store.save({ ...review, status: "cancelled" });
    }
  }

  /** A message from CodeDen to the Planner, queued behind its turn when it is busy. */
  private async tell(sessionId: string, text: string): Promise<void> {
    const session = this.deps.repo.find(sessionId)?.session;
    if (!session || session.archivedAt) {
      throw conflict("The Planner session is gone: start Plan with me again", "no_planner");
    }
    await this.deps.sessions.send(
      sessionId,
      { input: { text, attachments: [], from: "codeden" }, whenBusy: "queue" },
      "codeden",
    );
  }

  // ---------------------------------------------------------------- helpers

  private reviewOf(sessionId: string, status: PlanReview["status"]): PlanReview | undefined {
    return this.deps.store
      .open()
      .find(
        (r) =>
          r.status === status &&
          r.reviewers.some((x) => x.sessionId === sessionId && x.status === "running"),
      );
  }

  private ready(projectId: string): PlanReview {
    this.deps.projects.get(projectId);
    const review = this.deps.store.latest(projectId);
    if (review?.status !== "ready") {
      throw conflict("There is no table waiting for your answers", "no_plan_review");
    }
    return review;
  }

  private prerequisites(projectId: string) {
    const project = this.deps.projects.get(projectId);
    const plan = readPlan(project);
    if (!plan.exists) {
      throw conflict("Write the plan first: there is nothing to review yet", "no_plan");
    }
    const planner = openPlanner(this.deps.repo as SessionRepo, project.id);
    if (!planner) {
      throw conflict(
        "Open Plan with me first: the Planner settles what the reviewers say",
        "no_planner",
      );
    }
    return { project, plan, planner };
  }
}

function sessionOf(res: StartSessionResponse): string {
  if ("sessionId" in res) return res.sessionId;
  throw conflict("The reviewer could not start", "plan_review_failed");
}
