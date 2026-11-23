import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAN_BRIEF_MAX, PLAN_PATH } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLAN_TEMPLATE,
  planBlock,
  planBrief,
  readPlan,
  withPlan,
  writePlan,
} from "../src/services/projects/plan-file";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";
import { removeTree } from "./support/remove-tree";

// §8.5: the project plan, `.codeden/PLAN.md` beside the vision, which briefs carry.

const dirs: string[] = [];
let env: FactoryEnv | undefined;
afterEach(async () => {
  env?.close();
  env = undefined;
  for (const dir of dirs.splice(0)) await removeTree(dir);
});

function folder() {
  const path = mkdtempSync(join(tmpdir(), "codeden-plan-file-"));
  dirs.push(path);
  return { path };
}

const PLAN = "# Plan\n\n## First version\n- Paste a link, get a summary\n";

describe("The project plan file", () => {
  it("is the template until saved, then the saved text", () => {
    const project = folder();
    expect(readPlan(project)).toEqual({ path: PLAN_PATH, exists: false, contents: PLAN_TEMPLATE });
    expect(planBrief(project)).toBe("");
    const saved = writePlan(project, PLAN.trimEnd());
    expect(saved).toMatchObject({ exists: true, contents: PLAN });
    expect(readFileSync(join(project.path, PLAN_PATH), "utf8")).toBe(PLAN);
    expect(planBrief(project)).toBe(PLAN.trim());
  });

  it("is cut for a brief at a line break, with a pointer to the file", () => {
    const project = folder();
    mkdirSync(join(project.path, ".codeden"));
    const line = `- ${"x".repeat(98)}\n`;
    writeFileSync(join(project.path, PLAN_PATH), `# Plan\n\n${line.repeat(200)}`);
    const brief = planBrief(project);
    expect(brief.length).toBeLessThan(PLAN_BRIEF_MAX + 100);
    expect(brief).toMatch(/x\n\n\(The plan goes on: read the rest in `\.codeden\/PLAN\.md`\.\)$/);
  });

  it("goes after a session's brief as a block, and nothing is added without one", () => {
    const project = folder();
    expect(planBlock("")).toBe("");
    expect(withPlan("Fix the login bug.", project)).toBe("Fix the login bug.");
    writePlan(project, PLAN);
    const brief = withPlan("Fix the login bug.", project);
    expect(brief.startsWith("Fix the login bug.\n\n<plan>\n")).toBe(true);
    expect(brief).toContain("Paste a link, get a summary");
    expect(brief.endsWith("</plan>")).toBe(true);
  });
});

describe("The project plan in the factory", () => {
  it("is in the briefs of builders and reviewers", async () => {
    env = createFactoryEnv({ limits: { maxConcurrentSessions: 4 } });
    const steps = factorySteps(() => env as FactoryEnv);
    writePlan(env.project, PLAN);
    await steps.enable("software_factory", { autoMerge: false });
    const verifying = await steps.verifying("success", "Add a counter", 3);
    const brief = (workKey: string) =>
      env?.starts.filter((s) => s.workKey === workKey).at(-1)?.input?.text ?? "";
    expect(brief("issue:3")).toContain("<plan>");
    expect(brief("issue:3")).toContain("Paste a link, get a summary");
    expect(brief(`factory:review:${verifying.pr.ref.number}`)).toContain("<plan>");
  });

  it("is saved from the editor and shared through a pull request of its own", async () => {
    env = createFactoryEnv();
    expect(env.factory.plan(env.project.id)).toMatchObject({ exists: false });
    const saved = await env.factory.putPlan(env.project.id, PLAN);
    expect(saved).toMatchObject({ exists: true, contents: PLAN, pr: { number: 901 } });
    expect(env.gh.planCommits).toEqual([{ path: PLAN_PATH, contents: PLAN }]);
    expect(env.gh.visionCommits).toEqual([]);
  });
});
