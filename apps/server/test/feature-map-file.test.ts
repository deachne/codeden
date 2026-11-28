import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURE_MAP_BRIEF_MAX, FEATURE_MAP_PATH } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { tryoutPrompt } from "../src/services/factory/prompts-owner-checks";
import {
  FEATURE_MAP_TEMPLATE,
  featureMapBlock,
  featureMapBrief,
  readFeatureMap,
  withFeatureMap,
  writeFeatureMap,
} from "../src/services/projects/feature-map-file";
import { writePlan } from "../src/services/projects/plan-file";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";
import { removeTree } from "./support/remove-tree";

// §8.5: the feature map, `.codeden/FEATURE_MAP.md` beside the vision and the plan.

const dirs: string[] = [];
let env: FactoryEnv | undefined;
afterEach(async () => {
  env?.close();
  env = undefined;
  for (const dir of dirs.splice(0)) await removeTree(dir);
});

function folder() {
  const path = mkdtempSync(join(tmpdir(), "codeden-feature-map-"));
  dirs.push(path);
  return { path };
}

const MAP = "# Feature map\n\n## Home\n- The Summarize button: starts a summary\n";

describe("The feature map file", () => {
  it("is the template until saved, then the saved text", () => {
    const project = folder();
    expect(readFeatureMap(project)).toEqual({
      path: FEATURE_MAP_PATH,
      exists: false,
      contents: FEATURE_MAP_TEMPLATE,
    });
    expect(featureMapBrief(project)).toBe("");
    const saved = writeFeatureMap(project, MAP.trimEnd());
    expect(saved).toMatchObject({ exists: true, contents: MAP });
    expect(readFileSync(join(project.path, FEATURE_MAP_PATH), "utf8")).toBe(MAP);
    expect(featureMapBrief(project)).toBe(MAP.trim());
  });

  it("is cut for a brief at a line break, with a pointer to the file", () => {
    const project = folder();
    mkdirSync(join(project.path, ".codeden"));
    const line = `- ${"x".repeat(98)}\n`;
    writeFileSync(join(project.path, FEATURE_MAP_PATH), `# Feature map\n\n${line.repeat(100)}`);
    const brief = featureMapBrief(project);
    expect(brief.length).toBeLessThan(FEATURE_MAP_BRIEF_MAX + 100);
    expect(brief).toMatch(
      /x\n\n\(The feature map goes on: read the rest in `\.codeden\/FEATURE_MAP\.md`\.\)$/,
    );
  });

  it("goes after a session's brief as a block, and nothing is added without one", () => {
    const project = folder();
    expect(featureMapBlock("")).toBe("");
    expect(withFeatureMap("Fix the login bug.", project)).toBe("Fix the login bug.");
    writeFeatureMap(project, MAP);
    const brief = withFeatureMap("Fix the login bug.", project);
    expect(brief.startsWith("Fix the login bug.\n\n<feature_map>\n")).toBe(true);
    expect(brief).toContain("The Summarize button");
    expect(brief.endsWith("</feature_map>")).toBe(true);
  });
});

describe("The feature map in the factory", () => {
  it("is in the briefs of builders and reviewers, after the plan", async () => {
    env = createFactoryEnv({ limits: { maxConcurrentSessions: 4 } });
    const steps = factorySteps(() => env as FactoryEnv);
    writePlan(env.project, "# Plan\n\n## First version\n- One page\n");
    writeFeatureMap(env.project, MAP);
    await steps.enable("software_factory", { autoMerge: false });
    const verifying = await steps.verifying("success", "Add a counter", 3);
    const brief = (workKey: string) =>
      env?.starts.filter((s) => s.workKey === workKey).at(-1)?.input?.text ?? "";
    const builder = brief("issue:3");
    expect(builder).toContain("The Summarize button");
    expect(builder.indexOf("</plan>")).toBeLessThan(builder.indexOf("<feature_map>"));
    expect(brief(`factory:review:${verifying.pr.ref.number}`)).toContain("<feature_map>");
  });

  it("is saved from the editor and shared through a pull request of its own", async () => {
    env = createFactoryEnv();
    expect(env.factory.featureMap(env.project.id)).toMatchObject({ exists: false });
    const saved = await env.factory.putFeatureMap(env.project.id, MAP);
    expect(saved).toMatchObject({ exists: true, contents: MAP, pr: { number: 902 } });
    expect(env.gh.featureMapCommits).toEqual([{ path: FEATURE_MAP_PATH, contents: MAP }]);
    expect(env.gh.planCommits).toEqual([]);
    expect(env.gh.visionCommits).toEqual([]);
  });
});

describe("The feature map in the owner-check tryout's brief", () => {
  it("is added when the project has one, and left out when not", () => {
    const dev = { command: "pnpm dev" } as Parameters<typeof tryoutPrompt>[2];
    const checks = [{ text: "I press the Summarize button" }];
    expect(tryoutPrompt({ label: "pull request #3" }, checks, dev)).not.toContain("<feature_map>");
    const brief = tryoutPrompt({ label: "pull request #3" }, checks, dev, MAP);
    expect(brief).toContain("<feature_map>");
    expect(brief).toContain("The Summarize button: starts a summary");
    expect(brief).toContain("1. I press the Summarize button");
  });
});
