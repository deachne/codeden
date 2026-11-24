import { PLANNER_WORK_KEY, ProposePlanInput, type Session } from "@codeden/contracts";
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

/**
 * `propose_plan`: the Planner hands over the vision and the plan. CodeDen saves both as the Vision
 * and Plan pages do, and a project still being planned waits for its owner's approval.
 */
export const proposePlan = defineTool({
  name: "propose_plan",
  description:
    "Hand over the project's vision and plan once the owner has said yes to them: the full text of both files. CodeDen saves them (in a GitHub project, a small pull request for each) and the project's plan then waits for the owner to approve it. You can't approve it. Call it again with both files after any change the owner asks for.",
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
      const project = services.projects.markPlanProposed(session.projectId);
      const next =
        project.planStatus === "approved"
          ? "The plan was already approved, so agents keep working from the new files. Tell the owner what changed."
          : "Now tell the owner, in plain words, to read them on the Vision and Plan pages and press Approve plan on the project page when they're happy. Only the owner can approve.";
      return [shared("Vision", vision), shared("Plan", plan), "", next].join("\n");
    });
  },
});
