import {
  type Automation,
  type AutonomyLevel,
  type ConflictDecision,
  type GitHubIssueRef,
  type GithubIssue,
  type Project,
  type ProviderId,
  type ReasoningEffort,
  type StartedBy,
  StartSessionRequest,
} from "@codeden/contracts";
import { renderTemplate, runHeader, type TemplateVars } from "./prompt";

/** How a trigger reads in the header of the session it starts. */
export const TRIGGER_TEXT = {
  cron: "scheduled",
  catch_up: "catching up a missed schedule",
  event: "event trigger",
  manual: "run by hand",
} as const;

/** What a session an automation starts is made from (a session action, or a recipe's step). */
export interface SessionRecipe {
  prompt: string;
  title?: string;
  provider?: ProviderId;
  model?: string;
  effort?: ReasoningEffort;
}

/** The run the session belongs to. */
export interface SessionRunInfo {
  id: string;
  purpose: string;
  workKey: string;
  startedBy: StartedBy;
  triggeredBy: keyof typeof TRIGGER_TEXT;
}

/**
 * The request that starts the agent session of an automation run (§10): the prompt under the
 * run header, the action's agent, the permission level `autonomy` (already capped at what a
 * person approved), the run's work key, and the issue a triage or issue-event run is about.
 */
export function automationSessionRequest(args: {
  automation: Automation;
  project: Project;
  run: SessionRunInfo;
  action: SessionRecipe;
  vars: TemplateVars;
  autonomy: AutonomyLevel | undefined;
  issue?: GithubIssue | GitHubIssueRef;
  decision?: ConflictDecision;
}): StartSessionRequest {
  const { automation, project, run, action, vars, issue } = args;
  const prompt = renderTemplate(action.prompt, vars);
  return StartSessionRequest.parse({
    projectId: project.id,
    role: "agent",
    provider: action.provider,
    model: action.model,
    effort: action.effort,
    autonomy: args.autonomy,
    purpose: run.purpose,
    workKey: run.workKey,
    startedBy: run.startedBy,
    title: action.title ? renderTemplate(action.title, vars) : automation.name,
    issue: issue ? { number: issue.number, url: issue.url, title: issue.title } : undefined,
    input: {
      text: `${runHeader(automation, run.id, TRIGGER_TEXT[run.triggeredBy])}\n\n${prompt}`,
      attachments: [],
      from: "automation",
    },
    conflict: args.decision,
  });
}
