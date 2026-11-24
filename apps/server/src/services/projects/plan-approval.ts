import { createHash } from "node:crypto";
import type { Project, StartSessionRequest } from "@codeden/contracts";
import { conflict } from "../errors";
import { readVision } from "../factory/vision";
import type { NoticeDraft } from "../orchestration/notices";
import { readPlan } from "./plan-file";
import type { ProjectService } from "./project-service";

/**
 * Plan approval (§8.5). A new project starts in `planning`; until a person approves its plan,
 * CodeDen starts no agent session that someone other than a person asked for, and the factory
 * modes stay off. The rule lives here, in the server, so an agent can't skip it.
 */

/** True when the project's plan is approved and work may run as usual. */
export function planApproved(project: Pick<Project, "planStatus">): boolean {
  // Projects written before plan approval existed carry no status: they count as approved.
  return (project.planStatus ?? "approved") === "approved";
}

/** What the refusal says, to the PM, the orchestrator or the automation that asked. */
export function planNotApprovedMessage(project: Pick<Project, "name">): string {
  return `The plan for ${project.name} isn't approved yet, so CodeDen starts no work in it. The owner plans it with "Plan with me" and approves it with "Approve plan" on the project page. Until then, no session can be started for this project except by the owner.`;
}

/**
 * Refuse a session start while the plan isn't approved, unless a person asked for it. Role
 * sessions (the PM and the orchestrator themselves) always start: they are how the plan gets made.
 */
export function assertPlanAllowsStart(
  project: Project | null,
  req: Pick<StartSessionRequest, "role" | "startedBy">,
): void {
  if (!project || planApproved(project)) return;
  if (req.role !== "agent" || req.startedBy.kind === "user") return;
  throw conflict(planNotApprovedMessage(project), "plan_not_approved");
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** SHA-256 of the project's vision file; null when it has none. */
export function visionFingerprint(project: Project): string | null {
  const vision = readVision(project);
  return vision.exists ? sha256(vision.contents) : null;
}

/** SHA-256 of the project's plan file (`.codeden/PLAN.md`); null when it has none. */
export function planFingerprint(project: Project): string | null {
  const plan = readPlan(project);
  return plan.exists ? sha256(plan.contents) : null;
}

/** The project with its plan approved now, recording which vision and plan the person read. */
export function withPlanApproved(project: Project, now: string): Project {
  return {
    ...project,
    planStatus: "approved",
    planApproval: {
      approvedAt: now,
      visionSha256: visionFingerprint(project),
      planSha256: planFingerprint(project),
    },
    updatedAt: now,
  };
}

/**
 * The notice that wakes the project's PM once the owner approves a plan that wasn't approved
 * (§8.5): it turns the plan's first version into jobs. Approving an approved plan again sends none.
 */
export function planApprovedNotice(before: Project, after: Project): NoticeDraft | null {
  if (planApproved(before) || !after.planApproval) return null;
  const { approvedAt, planSha256 } = after.planApproval;
  return {
    id: `plan.approved:${after.id}:${approvedAt}`,
    type: "plan.approved",
    projectId: after.id,
    target: "pm",
    sessionId: null,
    title: `Plan approved: ${after.name}`,
    data: { approvedAt, mode: after.autonomyMode, hasPlan: planSha256 !== null },
  };
}

/** Approve the plan (only a person, through the API) and wake the PM when it was waiting. */
export function approvePlanAndWakePm(
  deps: {
    projects: Pick<ProjectService, "get" | "approvePlan">;
    notify: (draft: NoticeDraft, wake: boolean) => unknown;
  },
  projectId: string,
): Project {
  const before = deps.projects.get(projectId);
  const after = deps.projects.approvePlan(projectId);
  const notice = planApprovedNotice(before, after);
  if (notice) deps.notify(notice, true);
  return after;
}
