import {
  MAX_OWNER_CHECKS,
  PLANNER_WORK_KEY,
  ProposePlanInput,
  type Session,
} from "@codeden/contracts";
import type { AppServices } from "../../services/container";
import { defineTool, ToolError } from "../define";
import { asTool, forSession } from "./factory/shared";

/**
 * A project's Planner session (§8.5): the one a person started with "Plan with me". A session a
 * PM or the orchestrator started with the same work key is not one, so no agent can rewrite the
 * vision through this tool on its own.
 */
function plannerSession(
  services: AppServices,
  sessionId: string,
): (Session & { projectId: string }) | undefined {
  const session = services.sessionRepo.find(sessionId)?.session;
  if (!session?.projectId || session.role !== "agent") return undefined;
  if (session.workKey !== PLANNER_WORK_KEY || session.startedBy.kind !== "user") return undefined;
  return { ...session, projectId: session.projectId };
}

function shared(
  label: string,
  res: { path: string; pr?: { url: string } | null; shareError?: string | null },
) {
  if (res.shareError)
    return `${label} saved in ${res.path}, but not committed to GitHub: ${res.shareError}`;
  if (res.pr) return `${label} saved in ${res.path} and shared through ${res.pr.url}`;
  return `${label} saved in ${res.path}`;
}

const sameCheck = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Add the Planner's owner checks the project doesn't have yet, up to the most a project can have.
 * Returns what to tell the Planner, or null when it handed over none.
 */
function addOwnerChecks(services: AppServices, projectId: string, texts: string[]): string | null {
  if (texts.length === 0) return null;
  const have = new Set(
    services.factory.ownerChecks(projectId).checks.map((c) => sameCheck(c.text)),
  );
  let added = 0;
  let full = 0;
  for (const text of texts) {
    if (have.has(sameCheck(text))) continue;
    if (have.size >= MAX_OWNER_CHECKS) {
      full++;
      continue;
    }
    services.factory.addOwnerCheck(projectId, text);
    have.add(sameCheck(text));
    added++;
  }
  const already = texts.length - added - full;
  return [
    `Owner checks: ${added} added`,
    already > 0 ? `, ${already} the project already had` : "",
    full > 0 ? `, ${full} left out (a project can have ${MAX_OWNER_CHECKS})` : "",
    ". They're kept out of the files, so builders never see them.",
  ].join("");
}

/**
 * `propose_plan`: the Planner hands over the vision and the plan. CodeDen saves both as the Vision
 * and Plan pages do, adds the owner's checks to its owner checks, and a project still being planned
 * waits for its owner's approval.
 */
export const proposePlan = defineTool({
  name: "propose_plan",
  description:
    "Hand over the project's vision, plan and feature map once the owner has said yes to them: the full text of the files (`featureMap` is the feature map; leave it out to keep the project's current one), and how the owner will check it works as `ownerChecks` (short scenarios in their words, never written into the files). CodeDen saves the files (in a GitHub project, a small pull request for each), adds the checks the project doesn't have yet to its owner checks, and the project's plan then waits for the owner to approve it. You can't approve it. Call it again with the files after any change the owner asks for.",
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: forSession((services, id) => plannerSession(services, id) !== undefined),
  input: ProposePlanInput,
  handler: async (input, { services, sessionId }) => {
    const session = plannerSession(services, sessionId);
    if (!session)
      throw new ToolError("Only a Planner session the owner started can hand over a plan");
    return asTool(async () => {
      const vision = await services.factory.putVision(session.projectId, input.vision);
      const plan = await services.factory.putPlan(session.projectId, input.plan);
      const featureMap = input.featureMap
        ? await services.factory.putFeatureMap(session.projectId, input.featureMap)
        : null;
      const checks = addOwnerChecks(services, session.projectId, input.ownerChecks);
      const project = services.projects.markPlanProposed(session.projectId);
      const next =
        project.planStatus === "approved"
          ? "The plan was already approved, so agents keep working from the new files. Tell the owner what changed."
          : "Now tell the owner, in plain words, to read the Vision and Plan pages (and the Feature map page, if you sent one) and the Owner checks on the project page, and press Approve plan when they're happy. Only the owner can approve.";
      return [
        shared("Vision", vision),
        shared("Plan", plan),
        featureMap ? shared("Feature map", featureMap) : null,
        checks,
        "",
        next,
      ]
        .filter((line) => line !== null)
        .join("\n");
    });
  },
});
