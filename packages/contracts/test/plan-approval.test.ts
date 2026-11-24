import { describe, expect, it } from "vitest";
import {
  PLAN_PATH,
  PlanApproval,
  PlanResponse,
  Project,
  ProjectStatus,
  PutPlanRequest,
  UpdateProjectRequest,
} from "../src";
import { sampleProject } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

// §8.5: a new project's plan waits for a person's approval before agents build.
describe("A project's plan status", () => {
  it("is approved for projects written before it existed", () => {
    const { planStatus: _s, planApproval: _a, ...rest } = sampleProject;
    expect(Project.parse(rest)).toMatchObject({ planStatus: "approved", planApproval: null });
  });

  it("round-trips while planning and once approved", () => {
    expect(roundTrip(Project, { ...sampleProject, planStatus: "planning" }).planStatus).toBe(
      "planning",
    );
    const approval = {
      approvedAt: "2026-11-23T22:00:00.000Z",
      visionSha256: "a".repeat(64),
      planSha256: "b".repeat(64),
    };
    const approved = roundTrip(Project, {
      ...sampleProject,
      planStatus: "approved",
      planApproval: approval,
    });
    expect(approved.planApproval).toEqual(approval);
    expect(
      roundTrip(Project, { ...sampleProject, planApproval: { ...approval, visionSha256: null } })
        .planApproval?.visionSha256,
    ).toBeNull();
    expect(Project.safeParse({ ...sampleProject, planStatus: "done" }).success).toBe(false);
    expect(
      Project.safeParse({ ...sampleProject, planApproval: { ...approval, visionSha256: "abc" } })
        .success,
    ).toBe(false);
  });

  it("can't be changed through the project update request", () => {
    expect(UpdateProjectRequest.parse({ planStatus: "approved" })).not.toHaveProperty("planStatus");
  });

  it("is approved in a project status written before it existed", () => {
    const status = ProjectStatus.parse({
      project: { id: "p1", name: "Shop", kind: "local", mode: "assisted" },
      running: [],
      queued: [],
      scheduled: [],
      inbox: { open: 0, items: [] },
      recent: [],
      factory: null,
    });
    expect(status.project.plan).toBe("approved");
  });

  it("reads approvals recorded before the plan file existed", () => {
    const approval = { approvedAt: "2026-11-23T22:00:00.000Z", visionSha256: null };
    expect(PlanApproval.parse(approval)).toEqual({ ...approval, planSha256: null });
  });
});

describe("The project plan file", () => {
  it("round-trips, with the pull request that shares it", () => {
    const plan = roundTrip(PlanResponse, {
      path: PLAN_PATH,
      exists: true,
      contents: "# Plan\n",
      pr: { number: 9, url: "https://github.com/o/r/pull/9", state: "open", title: "Update" },
      shareError: null,
    });
    expect(plan.pr?.number).toBe(9);
    expect(roundTrip(PlanResponse, { path: PLAN_PATH, exists: false, contents: "" }).pr).toBe(
      undefined,
    );
    expect(PutPlanRequest.safeParse({ contents: "" }).success).toBe(false);
  });
});
