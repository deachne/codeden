import {
  FEATURE_MAP_PATH,
  PLAN_PATH,
  PLANNER_WORK_KEY,
  type Project,
  type Session,
  type StartPlannerResponse,
  StartSessionRequest,
} from "@codeden/contracts";
import type { SettingsStore } from "../../settings-store";
import { conflict, ServiceError } from "../errors";
import { readVision } from "../factory/vision";
import type { SessionRepo } from "../sessions/repo";
import type { SessionService } from "../sessions/session-service";
import { readFeatureMap } from "./feature-map-file";
import { readPlan } from "./plan-file";
import type { ProjectService } from "./project-service";

/**
 * The Planner (§8.5): an agent session a person starts with "Plan with me". It looks at what the
 * project already has, grills the owner one question at a time, and hands the vision and the plan
 * over with `propose_plan`. It builds nothing. Its provider and model come from
 * `settings.providers.planner` (an ordinary agent session's when that is `auto`).
 */

export interface PlannerDeps {
  projects: Pick<ProjectService, "get">;
  sessions: Pick<SessionService, "start">;
  repo: Pick<SessionRepo, "list">;
  settings: Pick<SettingsStore, "get">;
}

/** The project's Planner session that isn't archived, newest first; undefined when none. */
export function openPlanner(
  repo: Pick<SessionRepo, "list">,
  projectId: string,
): Session | undefined {
  return repo
    .list({ projectId, workKey: PLANNER_WORK_KEY, role: "agent" })
    .find((s) => !s.archivedAt && s.startedBy.kind === "user");
}

/** Start the project's Planner, or hand back the one already open. Only a person calls this. */
export async function startPlanner(
  deps: PlannerDeps,
  projectId: string,
): Promise<StartPlannerResponse> {
  const project = deps.projects.get(projectId);
  const open = openPlanner(deps.repo, project.id);
  if (open) return { sessionId: open.id, status: "existing" };
  const choice = deps.settings.get().providers.planner;
  const req = StartSessionRequest.parse({
    projectId: project.id,
    role: "agent",
    ...(choice.provider !== "auto"
      ? {
          provider: choice.provider,
          ...(choice.model ? { model: choice.model } : {}),
          ...(choice.effort ? { effort: choice.effort } : {}),
        }
      : {}),
    // It builds nothing, so it runs read-only where the provider can enforce that (§11.2).
    autonomy: "read_only",
    purpose: "Plan the project with the owner: vision and plan",
    workKey: PLANNER_WORK_KEY,
    title: `Plan ${project.name}`.slice(0, 200),
    startedBy: { kind: "user" },
    input: { text: plannerBrief(project), attachments: [] },
  });
  const res = await deps.sessions.start(req).catch((error: unknown) => {
    // A provider that can't enforce read-only still plans: its brief says it builds nothing.
    if (error instanceof ServiceError && error.code === "read_only_unsupported") {
      const { autonomy: _readOnly, ...rest } = req;
      return deps.sessions.start(rest);
    }
    throw error;
  });
  if (res.status === "started" || res.status === "queued") {
    return { sessionId: res.sessionId, status: res.status };
  }
  if (res.status === "joined") return { sessionId: res.sessionId, status: "existing" };
  throw conflict("A Planner session is already running in this project", "planner_running");
}

function fileBlock(tag: string, path: string, exists: boolean, contents: string): string {
  return exists
    ? [`<${tag} path="${path}">`, contents.trim(), `</${tag}>`].join("\n")
    : `There is no \`${path}\` yet. Start from these headings:\n<${tag}_template>\n${contents.trim()}\n</${tag}_template>`;
}

/** The Planner's first message: what it is for, what the project has, and how to hand over. */
export function plannerBrief(project: Project): string {
  const vision = readVision(project);
  const plan = readPlan(project);
  const featureMap = readFeatureMap(project);
  return [
    `You are the **Planner** for the project **${project.name}**. With its owner, you work out three short files and hand them over: the **vision** (\`${vision.path}\`: why the project exists, for whom, what's out of bounds) the **plan** (\`${PLAN_PATH}\`: what gets built first and how) and the **feature map** (\`${FEATURE_MAP_PATH}\`: every screen and button a person can reach). You build nothing: no code changes, commits, pull requests or other sessions. Progress is tracked later in GitHub issues, so the plan is not a task list.`,
    "",
    "**1. Look first.** If the folder already has code or documents (a README, a PRD, a status file, docs), read them before you ask anything: read-only, and skip nested clones, vendored or generated folders. Then give the owner a short plain-words report: what exists, what works, what looks unfinished or risky. Don't ask what the files already answer.",
    "",
    "**2. Ask, one question at a time.** Each question gets your recommended answer and one line on why, in plain everyday words. Ask with `ask_user` (wait: false; your recommendation first and marked recommended; 2 to 4 options, plus room for the owner's own answer), then end your turn: the answer comes as the next message. Walk the open decisions in this order, skipping what is already settled:",
    "- What it is for, and who uses it.",
    "- The goals for the next few months.",
    "- The principles it keeps, and the quality bar (how good is good enough).",
    "- What's out of scope, and the protected areas: paths or topics a person must always review.",
    "- The smallest first version worth using.",
    "- The main technical route: language and framework, where data lives, what runs where.",
    "- What waits until after the first version.",
    '- How the owner will check it works: a few short scenarios in their own words ("I paste a link and get a summary with timestamps"). These become owner checks.',
    `**The feature map.** A plain list of every screen and button a person can reach, so the owner, builders and checkers all use the same words ("the Export button on the project page", not "the thing on the left"). Format: a \`## \` heading per screen, in the owner's name for it, then \`- \` bullets, one per button or action: \`- The "Export" button: saves the report as a PDF\`. Mark anything not built yet with \`(planned)\` after its name. Use the owner's words, not code names, and keep it short: names and one line on what each does, no layout or design. Draft it as soon as you know the first version, and keep it current when the owner changes the plan. For an existing project, draft it from the code you read (read-only; routes, pages, menus, buttons), then confirm it with the owner one screen per question: name the screen, list what you found on it, and ask what they call it and what is missing or should go. Don't write the map from guesses.`,
    "",
    "If a planning or grilling skill is installed (for example one with `kickoff`, `plan` or `grill` in its name), use its questions instead of these, and still hand over as below. Stop when the owner says enough or nothing important is open.",
    "",
    "**3. Hand over.** Draft all three files, short and concrete. The vision keeps its `##` headings exactly (Goals, Target users, Principles, Out of scope, Quality bar, Protected areas), with `- ` bullets under each, and protected paths in backticks; CodeDen reads those headings. Keep the owner's checks out of all three files: builders read the files (the feature map included, since it only names the places in the app), and owner checks are kept from them on purpose, so they can't build to the test. Tell the owner in plain words what the two files and the checks say and ask for a clear yes. Write the owner's checks with the feature map's exact names for screens and buttons. On a yes, call `propose_plan` with the full text of the three files (the map as `featureMap`) and the checks as `ownerChecks`. CodeDen saves the files (in a GitHub project, a small pull request for each), adds the checks to the project's owner checks, and the project's plan waits for the owner. Then tell the owner to read the **Vision**, **Plan** and **Feature map** pages and the **Owner checks** on the project page, and to press **Approve plan** when they're happy. Only the owner approves; you never can.",
    "",
    "If the owner asks for changes after the hand-over, make them with them and call `propose_plan` again with all three files (checks the project already has aren't added twice; the owner edits or removes checks on the project page).",
    "",
    fileBlock("vision", vision.path, vision.exists, vision.contents),
    "",
    fileBlock("plan", plan.path, plan.exists, plan.contents),
    "",
    fileBlock("feature_map", featureMap.path, featureMap.exists, featureMap.contents),
  ].join("\n");
}
