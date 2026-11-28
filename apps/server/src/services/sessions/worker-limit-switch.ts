import {
  type AgentEventOf,
  agentEventToNewEvent,
  type InboxItem,
  PROVIDER_SWITCH_CODE,
  type ProviderInfo,
  type ProviderSwitchData,
  type RawEventEnvelope,
  type Session,
} from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import type { SettingsStore } from "../../settings-store";
import { errorMessage } from "../errors";
import type { InboxService } from "../inbox-service";
import { afterLimit, pickFallback, switchText } from "../orchestration/role-fallback";
import { projectDefaultProvider } from "../projects/project-config";
import type { ProjectService } from "../projects/project-service";
import type { RunnerPort } from "../runner-port";
import type { AutoRetry } from "./auto-retry";
import { handoffBlocker } from "./handoff";
import { planModeUnsupported, readOnlyUnsupported } from "./permissions";
import type { SessionRepo } from "./repo";
import type { SessionService } from "./session-service";

export interface WorkerLimitSwitchDeps {
  store: Pick<EventStore, "append" | "subscribe">;
  repo: Pick<SessionRepo, "find" | "turnCount" | "setStartMeta">;
  sessions: Pick<SessionService, "switchProvider">;
  retries: Pick<AutoRetry, "handedOver">;
  inbox: Pick<InboxService, "put">;
  projects: Pick<ProjectService, "get">;
  settings: Pick<SettingsStore, "get">;
  /** The providers the runner loaded; only one of them can take work over. */
  runner: Pick<RunnerPort, "providers">;
  /**
   * Ids of the providers that can run new work now (installed and signed in). Without it, or
   * when it fails, every loaded provider counts as ready.
   */
  ready?: () => Promise<string[]>;
  /**
   * Whether the factory handles the session at a limit by its own rules (a reviewer, or work
   * with a pull request), so it isn't moved. Default: no.
   */
  keepsOwnRules?: (session: Session) => boolean;
  /** The work of a factory builder moved: its item follows the new session. */
  moved?: (from: Session, to: Session) => void;
  /** The user's IANA timezone, for the reset time in the notice. */
  timezone: () => string;
  now?: () => number;
  log?: (message: string) => void;
}

type TurnRef = { threadId: string; turnId: string };

/** The inbox item about a worker's provider switch: one per session that moved. */
export const workerSwitchInboxId = (sessionId: string) =>
  `inbox:provider-switch:session:${sessionId}`;

/**
 * "Switch provider automatically when a limit is hit" for worker sessions (§8.1,
 * `settings.providers.autoSwitchOnLimit`, on by default). When the root turn of an agent session
 * fails as `usage_limit`, its work continues in a new session on another ready provider: a
 * handoff (§9) that CodeDen makes by itself, with a brief of what was done and the same starter
 * as the work had. The provider is chosen as the roles' is (`pickFallback`), by what the
 * session needs (its permissions and plan mode) and never by provider id. The user is told in
 * the failed turn, in the new session's first turn and once in the inbox. The session left
 * behind isn't retried (`AutoRetry`), and the work doesn't move back after the reset.
 *
 * Nothing is switched, and the session waits for the reset as before, when the setting is off,
 * the session can't be handed off, the factory keeps it under its own rules (`keepsOwnRules`),
 * no provider can take over (a notice says why) or the handoff fails.
 */
export class WorkerLimitSwitch {
  /** Notices for a new session, shown in its first turn. */
  private readonly pending = new Map<string, { data: ProviderSwitchData; message: string }>();
  private unsubscribe: (() => void) | undefined;
  private work: Promise<void> = Promise.resolve();

  constructor(private readonly deps: WorkerLimitSwitchDeps) {}

  start(): void {
    this.unsubscribe = this.deps.store.subscribe((events) => this.onEvents(events));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Resolves once the switches started so far are done (tests). */
  async idle(): Promise<void> {
    // The failures seen so far are queued as microtasks first.
    await Promise.resolve();
    await this.work;
  }

  onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (!e.sessionId) continue;
      if (e.type === "agent.turn.started") {
        const waiting = this.pending.get(e.sessionId);
        if (!waiting) continue;
        this.pending.delete(e.sessionId);
        const event = e.payload as AgentEventOf<"turn.started">;
        this.notice(e.sessionId, event, waiting.data, waiting.message);
      } else if (e.type === "agent.turn.failed") {
        const event = e.payload as AgentEventOf<"turn.failed">;
        if (event.error.kind !== "usage_limit") continue;
        const sessionId = e.sessionId;
        // After the retry service has seen the failure, so its timer is there to cancel.
        queueMicrotask(() => {
          this.work = this.work
            .then(() => this.onLimit(sessionId, event))
            .catch((error) => this.deps.log?.(`worker switch: ${errorMessage(error)}`));
        });
      }
    }
  }

  private async onLimit(sessionId: string, event: AgentEventOf<"turn.failed">): Promise<void> {
    if (!this.deps.settings.get().providers.autoSwitchOnLimit) return;
    const found = this.deps.repo.find(sessionId);
    const session = found?.session;
    if (!session || session.role !== "agent" || session.archivedAt) return;
    if (session.rootThreadId && session.rootThreadId !== event.threadId) return;
    if (found.startMeta?.handedOffTo) return;
    if (!session.projectId || this.deps.keepsOwnRules?.(session)) return;
    if (handoffBlocker(session, this.deps.repo.turnCount(session.id))) return;

    const now = this.deps.now?.() ?? Date.now();
    const retryAt = event.error.retryAt ?? null;
    const fallback = afterLimit(found.startMeta?.fallback ?? null, session.provider, retryAt, now);
    const settings = this.deps.settings.get().providers;
    const project = this.deps.projects.get(session.projectId);
    const to = pickFallback({
      preferred: [settings.agent.provider, project && projectDefaultProvider(project)],
      providers: this.deps.runner.providers(),
      ready: await this.readyProviders(),
      limited: fallback.limited,
      now,
      canRun: (p) => canTakeOver(session, p),
    });
    const at = { threadId: event.threadId, turnId: event.turnId };
    if (!to) {
      const data = { reason: "no_fallback", from: session.provider, to: null, retryAt } as const;
      this.notice(session.id, at, data, this.text(data));
      return;
    }
    const data: ProviderSwitchData = { reason: "usage_limit", from: session.provider, to, retryAt };
    const message = this.text(data);
    const next = await this.deps.sessions.switchProvider(
      session.id,
      { provider: to, note: `${message} Continue where it left off.` },
      { fallback },
    );
    // From here the work is the new session's: never retried, told once, and its item follows.
    this.deps.repo.setStartMeta(session.id, (m) => ({
      ...(m ?? {
        workspaceMode: "worktree",
        workspaceFallback: null,
        forced: null,
        queuedBehind: [],
      }),
      handedOffTo: next.id,
    }));
    this.deps.retries.handedOver(session.id);
    this.pending.set(next.id, { data, message });
    this.notice(session.id, at, data, message);
    this.deps.inbox.put(this.inboxItem(session, next, message));
    try {
      this.deps.moved?.(session, next);
    } catch (error) {
      this.deps.log?.(`worker switch: ${errorMessage(error)}`);
    }
  }

  private async readyProviders(): Promise<Set<string> | null> {
    try {
      return this.deps.ready ? new Set(await this.deps.ready()) : null;
    } catch (error) {
      this.deps.log?.(`worker switch: ${errorMessage(error)}`);
      return null;
    }
  }

  private name(provider: string): string {
    return this.deps.runner.providers().find((p) => p.id === provider)?.displayName ?? provider;
  }

  private text(data: ProviderSwitchData): string {
    const names = {
      from: this.name(data.from),
      to: data.to ? this.name(data.to) : "",
      worker: true,
    };
    return switchText(data, names, this.deps.timezone());
  }

  private inboxItem(from: Session, to: Session, message: string): InboxItem {
    const now = new Date(this.deps.now?.() ?? Date.now()).toISOString();
    const what = (from.title ?? from.purpose).trim().slice(0, 80);
    return {
      id: workerSwitchInboxId(from.id),
      kind: "message",
      status: "open",
      priority: "normal",
      notify: "failure",
      title: `"${what}" moved to ${this.name(to.provider)}`,
      body: `${message} The work carries on in a new session with a summary of what was done.`,
      projectId: from.projectId,
      sessionId: to.id,
      threadId: null,
      itemId: null,
      requestId: null,
      issue: null,
      pr: null,
      automationRunId: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolution: null,
    };
  }

  private notice(sessionId: string, at: TurnRef, data: ProviderSwitchData, message: string): void {
    this.deps.store.append([
      agentEventToNewEvent(sessionId, {
        type: "item.completed",
        threadId: at.threadId,
        turnId: at.turnId,
        item: {
          id: `provider-switch-${at.turnId}`,
          kind: "notice",
          status: "completed",
          level: data.reason === "no_fallback" ? "warning" : "info",
          code: PROVIDER_SWITCH_CODE,
          message,
          data,
        },
      }),
    ]);
  }
}

/**
 * Whether `provider` can carry on the work of `session` at the permission level it has: it
 * enforces read-only when the session is read-only, and has plan mode while it is planning. Read
 * from the provider's capabilities, never its id (the same checks as a handoff).
 */
export function canTakeOver(session: Session, provider: ProviderInfo): boolean {
  if (readOnlyUnsupported("agent", session.autonomy, provider)) return false;
  return !(session.planMode && planModeUnsupported("agent", provider));
}
