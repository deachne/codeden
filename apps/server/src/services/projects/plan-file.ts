import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PLAN_BRIEF_MAX, PLAN_PATH, type PlanResponse, type Project } from "@codeden/contracts";

/**
 * The project plan (§8.5): `.codeden/PLAN.md`, beside the vision. The vision says why; the plan
 * says what gets built first and how. Progress lives in GitHub issues, not here. Briefs carry it
 * (`planBrief`), cut to `PLAN_BRIEF_MAX` characters.
 */

export const PLAN_TEMPLATE = `# Plan

What gets built first, and how. The vision says why the project exists; this file says what the
first version is. Progress lives in GitHub issues, not here.

## First version
- The smallest version worth using: what it does, for whom

## How it works
- The main technical route: language and framework, where data lives, what runs where

## Not yet
- What waits until after the first version

## How the owner checks it works
- In plain words, what you will try to know it's done

## Open questions
- Decisions still to make
`;

function planFile(project: Pick<Project, "path">): string {
  return resolve(project.path, PLAN_PATH);
}

/** Read the plan; the template (and `exists: false`) when the file is missing. */
export function readPlan(project: Pick<Project, "path">): PlanResponse {
  const file = planFile(project);
  const exists = existsSync(file);
  return { path: PLAN_PATH, exists, contents: exists ? readFileSync(file, "utf8") : PLAN_TEMPLATE };
}

/** Write the plan atomically (in the main checkout; commit it to share it with agents). */
export function writePlan(project: Pick<Project, "path">, contents: string): PlanResponse {
  const file = planFile(project);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents.endsWith("\n") ? contents : `${contents}\n`);
  renameSync(tmp, file);
  return readPlan(project);
}

/**
 * The plan as a brief carries it: the file's text, cut at a line break to `PLAN_BRIEF_MAX`
 * characters with a pointer to the file. Empty when there is no plan or it can't be read.
 */
export function planBrief(project: Pick<Project, "path">): string {
  let text: string;
  try {
    const plan = readPlan(project);
    text = plan.exists ? plan.contents.trim() : "";
  } catch {
    return "";
  }
  if (text.length <= PLAN_BRIEF_MAX) return text;
  const cut = text.slice(0, PLAN_BRIEF_MAX);
  const end = cut.lastIndexOf("\n");
  return `${(end > 0 ? cut.slice(0, end) : cut).trimEnd()}\n\n(The plan goes on: read the rest in \`${PLAN_PATH}\`.)`;
}

/** The plan as a block of a brief; empty when there is none. */
export function planBlock(plan: string | undefined): string {
  if (!plan?.trim()) return "";
  return [
    "<plan>",
    `The project's plan (\`${PLAN_PATH}\`): what gets built first, and how. Keep the work in line with it; if your task and the plan disagree, say so in your report.`,
    "",
    plan.trim(),
    "</plan>",
  ].join("\n");
}

/** A session's brief with the project plan after it (§8.5); the brief alone when there is none. */
export function withPlan(brief: string, project: Pick<Project, "path">): string {
  const block = planBlock(planBrief(project));
  return block ? `${brief}\n\n${block}` : brief;
}
