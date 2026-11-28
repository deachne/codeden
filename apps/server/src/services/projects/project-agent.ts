import type {
  InboxItem,
  Project,
  ProjectAgentChoice,
  ProviderInfo,
  Role,
  Settings,
} from "@codeden/contracts";

/**
 * A project's own provider, model and effort for its project manager and its workers (§8.1,
 * Defaults per role). The order for a new session is: what the start names (provider, model,
 * effort) > the project's choice for the role > the shared setting (the project's default
 * provider, then Settings > Providers). Left empty, a project follows the shared setting.
 */

/** The project's choice that applies to a session role: the PM's, the workers', else none. */
export function projectChoiceFor(
  project: Pick<Project, "pmChoice" | "workerChoice"> | null | undefined,
  role: Role,
): ProjectAgentChoice | null {
  if (!project) return null;
  if (role === "pm") return project.pmChoice ?? null;
  if (role === "agent") return project.workerChoice ?? null;
  return null;
}

/** What the check of a choice needs to know about the runner and its providers. */
export interface ChoiceEnv {
  /** Providers the connected runner offers. */
  providers: readonly Pick<ProviderInfo, "id" | "displayName" | "capabilities" | "models">[];
  /** False while the runner is away: nothing is known yet, so the choice is let through. */
  connected: boolean;
  /**
   * Why a provider can't take new work now, as a sentence ("Cursor is not signed in"); null when
   * it can. Absent: nothing is known about sign-in or limits.
   */
  providerProblem?: (provider: string) => string | null;
  /** Model ids the user added for a provider (`settings.models.custom`). */
  customModels?: Settings["models"]["custom"];
}

/** The model id that stands for "the provider's default model". */
const DEFAULT_MODEL_ID = "default";

/**
 * Whether the project's choice can run now: its tool is offered and ready, and the model is one
 * the tool lists (or a custom one). A provider whose model list depends on the project
 * (`capabilities.projectModels`), or that lists none, is trusted: the model is not checked.
 * `problem` is the plain-words reason when it can't, else null.
 */
export function checkChoice(
  choice: ProjectAgentChoice,
  env: ChoiceEnv,
): { usable: boolean; problem: string | null } {
  if (!env.connected) return { usable: true, problem: null };
  const info = env.providers.find((p) => p.id === choice.provider);
  if (!info) return { usable: false, problem: `${choice.provider} is not offered here` };
  const blocked = env.providerProblem?.(choice.provider) ?? null;
  if (blocked) return { usable: false, problem: blocked };
  const model = choice.model;
  if (!model || model === DEFAULT_MODEL_ID) return { usable: true, problem: null };
  if (info.capabilities.projectModels || info.models.length === 0) {
    return { usable: true, problem: null };
  }
  const listed = info.models.some((m) => m.id === model || m.resolvedId === model);
  const custom = (env.customModels?.[choice.provider] ?? []).some((m) => m.id === model);
  if (listed || custom) return { usable: true, problem: null };
  return { usable: false, problem: `${info.displayName} no longer lists the model ${model}` };
}

/** Who a choice is for, in the words of the notice. */
export function choiceWho(role: Role): string {
  return role === "pm" ? "the project manager" : "workers";
}

/** The sentence the owner reads when a project's choice can't be used. */
export function choiceFallbackText(project: Pick<Project, "name">, role: Role, problem: string) {
  return `${problem}, so ${choiceWho(role)} in ${project.name} use the shared setting from Settings → Providers for now. Pick another model in the project's settings, or leave it on the shared setting.`;
}

/** The inbox id of this notice: one per project and role, so it never piles up. */
export function choiceFallbackInboxId(projectId: string, role: Role): string {
  return `inbox:project-choice:${role}:${projectId}`;
}

/** The inbox message that says a project's choice fell back to the shared setting. */
export function choiceFallbackItem(
  project: Pick<Project, "id" | "name">,
  role: Role,
  problem: string,
  now: string,
): InboxItem {
  return {
    id: choiceFallbackInboxId(project.id, role),
    kind: "message",
    status: "open",
    priority: "normal",
    notify: "failure",
    title: `${project.name}: using the shared model for ${choiceWho(role)}`,
    body: choiceFallbackText(project, role, problem),
    projectId: project.id,
    sessionId: null,
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
