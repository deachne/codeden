import { randomUUID } from "node:crypto";
import {
  builderSafeObservation,
  type DevServerConfig,
  devServerOf,
  type FactoryItem,
  type FactoryTuning,
  MAX_OWNER_CHECKS,
  OWNER_CHECK_RUNS_LISTED,
  type OwnerCheck,
  type OwnerCheckRun,
  type OwnerCheckRunResult,
  type OwnerChecksResponse,
  type OwnerChecksSubmission,
  type Project,
} from "@codeden/contracts";
import { ServiceError } from "../errors";
import type { Exec } from "../exec";
import { readProjectConfig, readProjectConfigFromGit } from "../projects/project-config";
import type { OwnerChecksInput } from "./checks";
import type { FactoryContext } from "./context";

/**
 * Owner checks (§10.1, Owner checks): the owner's scenarios, kept in CodeDen's data folder, and
 * what the merge checks and the tryout agent's tool make of them. A failure reaches the builder
 * as a scenario number and the tryout's observation, never as the scenario's wording.
 */

/**
 * The project's `devServer` from `.codeden/project.json`. Read from the PR head (tryout worktree
 * if it exists, or `git show <head>:.codeden/project.json` before then), falling back to the main
 * checkout when the head has no config.
 */
export function projectDevServer(project: Pick<Project, "path">): DevServerConfig | undefined;
export function projectDevServer(
  project: Pick<Project, "path">,
  opts: { exec?: Exec; head?: string | null; worktree?: string | null },
): Promise<DevServerConfig | undefined>;
export function projectDevServer(
  project: Pick<Project, "path">,
  opts?: { exec?: Exec; head?: string | null; worktree?: string | null },
): DevServerConfig | undefined | Promise<DevServerConfig | undefined> {
  if (!opts || (!opts.exec && !opts.head && !opts.worktree)) {
    const config = readProjectConfig(project.path);
    return config ? devServerOf(config) : undefined;
  }
  return (async () => {
    if (opts.worktree) {
      const config = readProjectConfig(opts.worktree);
      if (config) {
        const dev = devServerOf(config);
        if (dev) return dev;
      }
    }
    if (opts.exec && opts.head) {
      const config = await readProjectConfigFromGit(opts.exec, project.path, opts.head);
      if (config) {
        const dev = devServerOf(config);
        if (dev) return dev;
      }
    }
    const config = readProjectConfig(project.path);
    return config ? devServerOf(config) : undefined;
  })();
}

/** The editor's view: the checks in force, the latest runs and whether a dev server is set. */
export function ownerChecksView(ctx: FactoryContext, project: Project): OwnerChecksResponse {
  const store = ctx.store.ownerChecks;
  return {
    checks: store.checks(project.id),
    runs: store.runs(project.id, OWNER_CHECK_RUNS_LISTED),
    devServer: projectDevServer(project) !== undefined,
  };
}

/** Write a new owner check. */
export function addOwnerCheck(ctx: FactoryContext, projectId: string, text: string): OwnerCheck {
  const store = ctx.store.ownerChecks;
  if (store.checks(projectId).length >= MAX_OWNER_CHECKS) {
    throw new ServiceError(
      409,
      "owner_checks_full",
      `A project can have up to ${MAX_OWNER_CHECKS} owner checks`,
    );
  }
  const at = ctx.now().toISOString();
  return store.saveCheck({
    id: randomUUID(),
    projectId,
    text: text.trim(),
    createdAt: at,
    updatedAt: at,
    removedAt: null,
    last: null,
  });
}

function existing(ctx: FactoryContext, projectId: string, checkId: string): OwnerCheck {
  const check = ctx.store.ownerChecks.check(projectId, checkId);
  if (!check || check.removedAt) {
    throw new ServiceError(404, "owner_check_not_found", "No such owner check");
  }
  return check;
}

/** Edit a check's wording; its last result is cleared, since the scenario changed. */
export function editOwnerCheck(
  ctx: FactoryContext,
  projectId: string,
  checkId: string,
  text: string,
): OwnerCheck {
  const check = existing(ctx, projectId, checkId);
  if (check.text === text.trim()) return check;
  const at = ctx.now().toISOString();
  return ctx.store.ownerChecks.saveCheck({
    ...check,
    text: text.trim(),
    updatedAt: at,
    last: null,
  });
}

/** Remove a check: later runs don't try it. */
export function removeOwnerCheck(
  ctx: FactoryContext,
  projectId: string,
  checkId: string,
): OwnerCheck {
  const check = existing(ctx, projectId, checkId);
  const at = ctx.now().toISOString();
  return ctx.store.ownerChecks.saveCheck({ ...check, removedAt: at, updatedAt: at });
}

/** Whether a run tried exactly the checks in force now (none added, edited or removed since). */
function coversNow(run: OwnerCheckRun, checks: readonly OwnerCheck[]): boolean {
  const started = Date.parse(run.startedAt);
  return (
    run.checkIds.length === checks.length &&
    checks.every((c, n) => run.checkIds[n] === c.id && Date.parse(c.updatedAt) <= started)
  );
}

/**
 * Where the owner checks stand on a factory PR's head, for `evaluateChecks`. Skipped when the
 * factory's switch is off, the project has none, or it sets no `devServer`; otherwise the latest
 * run of this head (and these checks) decides. A run that ended in error counts as not run.
 */
export async function ownerChecksInput(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  headSha: string | null,
  tuning: Pick<FactoryTuning, "ownerChecks">,
): Promise<OwnerChecksInput> {
  if (!tuning.ownerChecks) return { state: "skipped", why: "Owner checks are switched off" };
  const checks = ctx.store.ownerChecks.checks(project.id);
  if (checks.length === 0) return { state: "skipped", why: "The project has no owner checks" };
  const run = ctx.store.ownerChecks.latestForItem(item.id);
  const tryoutSession = run?.sessionId ? ctx.repo.find(run.sessionId)?.session : undefined;
  const worktree = tryoutSession?.worktreePath ?? null;
  const dev = await projectDevServer(project, {
    exec: ctx.exec,
    head: headSha,
    worktree,
  });
  if (!dev) {
    return {
      state: "skipped",
      why: "No devServer in .codeden/project.json, so the app can't be started to try them",
    };
  }
  const count = checks.length;
  if (!run || !headSha || run.headSha !== headSha || !coversNow(run, checks)) {
    return { state: "not_run", count };
  }
  if (run.state === "running") return { state: "running", count };
  if (run.state === "error") return { state: "not_run", count };
  if (run.state === "passed") return { state: "pass", count };
  return { state: "fail", count, failed: failedForBuilder(run, checks) };
}

/** A run's failed scenarios as the builder may read them: numbers and observations only. */
export function failedForBuilder(
  run: Pick<OwnerCheckRun, "results">,
  checks: readonly Pick<OwnerCheck, "id" | "text">[],
): { number: number; observation: string }[] {
  const text = new Map(checks.map((c) => [c.id, c.text]));
  return run.results
    .filter((r) => r.state === "fail")
    .map((r) => ({
      number: r.number,
      observation: builderSafeObservation(r.observation, text.get(r.checkId) ?? ""),
    }));
}

/**
 * `factory_submit_owner_checks`: the tryout agent's results for its run. Every scenario of its
 * brief needs one result; each check keeps it as its last result.
 */
export function submitOwnerChecks(
  ctx: FactoryContext,
  sessionId: string,
  submission: OwnerChecksSubmission,
): { recorded: boolean; message: string } {
  const run = ctx.store.ownerChecks.runOfSession(sessionId);
  if (!run) throw new ServiceError(409, "not_a_tryout", "This session runs no owner checks");
  if (run.state !== "running") {
    return { recorded: false, message: "Your results are already recorded: you are done." };
  }
  const byNumber = new Map(submission.results.map((r) => [r.number, r]));
  const missing = run.checkIds.flatMap((_, n) => (byNumber.has(n + 1) ? [] : [n + 1]));
  const extra = [...byNumber.keys()].filter((n) => n < 1 || n > run.checkIds.length);
  if (missing.length > 0 || extra.length > 0) {
    throw new ServiceError(
      400,
      "invalid_results",
      `Submit exactly one result for each scenario 1-${run.checkIds.length}${missing.length ? `; missing: ${missing.join(", ")}` : ""}${extra.length ? `; no such scenario: ${extra.join(", ")}` : ""}`,
    );
  }
  const at = ctx.now().toISOString();
  const results: OwnerCheckRunResult[] = run.checkIds.map((checkId, n) => {
    const r = byNumber.get(n + 1) as OwnerChecksSubmission["results"][number];
    return {
      checkId,
      number: n + 1,
      state: r.state,
      observation: r.observation,
      screenshot: r.screenshot ?? null,
    };
  });
  const passed = results.every((r) => r.state === "pass");
  ctx.store.ownerChecks.saveRun({
    ...run,
    state: passed ? "passed" : "failed",
    results,
    detail: null,
    endedAt: at,
  });
  for (const r of results) {
    const check = ctx.store.ownerChecks.check(run.projectId, r.checkId);
    // A check edited or removed since the run started keeps its own (cleared) record.
    if (!check || check.removedAt || Date.parse(check.updatedAt) > Date.parse(run.startedAt))
      continue;
    ctx.store.ownerChecks.saveCheck({
      ...check,
      last: {
        state: r.state,
        observation: r.observation,
        screenshot: r.screenshot,
        prNumber: run.prNumber,
        sessionId,
        at,
      },
    });
  }
  const failed = results.filter((r) => r.state === "fail").length;
  return {
    recorded: true,
    message: passed
      ? "Recorded: every scenario passed. Stop the dev server; you are done."
      : `Recorded: ${failed} of ${results.length} failed. Stop the dev server; you are done.`,
  };
}
