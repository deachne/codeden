import { describe, expect, it } from "vitest";
import { Project, ProjectAgentChoice, UpdateProjectRequest } from "../src";
import { sampleProject } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

// #178: a project's own provider, model and effort for its project manager and its workers.
describe("A project's own PM and worker choices", () => {
  const choice = { provider: "cursor", model: "deepseek-v4", effort: "low" };

  it("are null for projects written before they existed (they follow the shared setting)", () => {
    const { pmChoice: _p, workerChoice: _w, ...rest } = sampleProject;
    expect(Project.parse(rest)).toMatchObject({ pmChoice: null, workerChoice: null });
    expect(Project.parse(sampleProject)).toMatchObject({ pmChoice: null, workerChoice: null });
  });

  it("round-trip on a project, each on its own", () => {
    const project = roundTrip(Project, {
      ...sampleProject,
      pmChoice: choice,
      workerChoice: { provider: "claude", model: null, effort: null },
    });
    expect(project).toMatchObject({
      pmChoice: choice,
      workerChoice: { provider: "claude", model: null, effort: null },
    });
  });

  it("need a provider; the model and effort default to the provider's own", () => {
    expect(ProjectAgentChoice.parse({ provider: "codex" })).toEqual({
      provider: "codex",
      model: null,
      effort: null,
    });
    expect(ProjectAgentChoice.safeParse({ model: "opus" }).success).toBe(false);
    expect(ProjectAgentChoice.safeParse({ provider: "codex", model: "" }).success).toBe(false);
    expect(ProjectAgentChoice.safeParse({ provider: "codex", effort: "extreme" }).success).toBe(
      false,
    );
  });

  it("are set and cleared through the project update request", () => {
    const set = { pmChoice: choice, workerChoice: { ...choice, effort: null } };
    expect(roundTrip(UpdateProjectRequest, set)).toEqual(set);
    const cleared = { pmChoice: null, workerChoice: null };
    expect(roundTrip(UpdateProjectRequest, cleared)).toEqual(cleared);
    // Not named: left as it is.
    expect(UpdateProjectRequest.parse({})).toEqual({});
  });
});
