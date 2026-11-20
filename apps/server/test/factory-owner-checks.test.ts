import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OBSERVATION_WITHHELD, OWNER_CHECKS_WORK_KEY_PREFIX } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

// Issue #2: owner checks. The owner's scenarios are tried in the running app by a separate
// tryout agent once the review approved and CI passed; a failure goes back to the builder as a
// number and what the tryout saw, never the scenario's wording.

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, enable, verifying, review, later } = factorySteps(() => env);

const PASTE = "I paste a YouTube link and get a condensed version with timestamps";
const EXPORT = "I can export the summary as a PDF from the toolbar";

function withDevServer() {
  writeFileSync(
    join(env.project.path, ".codeden", "project.json"),
    JSON.stringify({ devServer: { command: "pnpm dev", port: 5173 } }),
  );
}

function ownerChecks(...texts: string[]) {
  for (const t of texts) env.factory.addOwnerCheck(env.project.id, t);
}

const tryoutStarts = () =>
  env.starts.filter((s) => (s.workKey ?? "").startsWith(OWNER_CHECKS_WORK_KEY_PREFIX));
const ownerCheck = (id: string) => item(id).checks.find((c) => c.name === "owner_checks");

/** A feature in verification whose review approved and whose CI passed. */
async function approved() {
  enable("software_factory", { autoMerge: true });
  const v = await verifying();
  await review(v.id);
  await tick();
  return v;
}

describe("owner checks (issue #2)", () => {
  it("are skipped, and nothing else changes, when the project has none", async () => {
    env = createFactoryEnv();
    withDevServer();
    const { id } = await approved();
    expect(ownerCheck(id)).toMatchObject({ state: "skipped" });
    expect(tryoutStarts()).toHaveLength(0);
    expect(item(id).checks.filter((c) => c.state === "pending")).toEqual([]);
  });

  it("are skipped when the project sets no devServer", async () => {
    env = createFactoryEnv();
    ownerChecks(PASTE);
    const { id } = await approved();
    expect(ownerCheck(id)).toMatchObject({
      state: "skipped",
      detail: expect.stringMatching(/devServer/),
    });
    expect(tryoutStarts()).toHaveLength(0);
  });

  it("are skipped when switched off", async () => {
    env = createFactoryEnv();
    withDevServer();
    ownerChecks(PASTE);
    enable("software_factory", { autoMerge: true, tuning: { ownerChecks: false } });
    const v = await verifying();
    await review(v.id);
    await tick();
    expect(ownerCheck(v.id)).toMatchObject({ state: "skipped" });
    expect(tryoutStarts()).toHaveLength(0);
  });

  it("start a separate tryout once review and CI pass; a failure sends numbers and observations back, never the wording", async () => {
    env = createFactoryEnv();
    withDevServer();
    ownerChecks(PASTE, EXPORT);
    const { id, builder } = await approved();
    const it0 = item(id);
    // The tryout is a fresh session on the PR's head, neither the builder nor the reviewer.
    expect(tryoutStarts()).toHaveLength(1);
    const start = tryoutStarts()[0];
    expect(start?.workspace).toMatchObject({ mode: "worktree", fetch: true });
    const tryout = env.repo
      .list()
      .find((s) => (s.workKey ?? "").startsWith(OWNER_CHECKS_WORK_KEY_PREFIX)) as { id: string };
    expect(tryout.id).not.toBe(builder);
    expect(tryout.id).not.toBe(it0.reviewerSessionId);
    // Only the tryout's brief carries the scenarios, and it says how to start the app.
    expect(start?.input?.text).toContain(PASTE);
    expect(start?.input?.text).toContain("pnpm dev");
    expect(ownerCheck(id)).toMatchObject({ state: "pending" });

    // The builder and reviewer briefs never had them.
    for (const s of env.starts.filter(
      (s) => !(s.workKey ?? "").startsWith(OWNER_CHECKS_WORK_KEY_PREFIX),
    )) {
      expect(s.input?.text ?? "").not.toContain(PASTE);
      expect(s.input?.text ?? "").not.toContain(EXPORT);
    }

    const res = env.factory.submitOwnerChecks(env.repo.get(tryout.id), {
      results: [
        { number: 1, state: "pass", observation: "The condensed text appeared with times." },
        {
          number: 2,
          state: "fail",
          observation: `The button did nothing: ${EXPORT}.`,
          screenshot: "art-1",
        },
      ],
    });
    expect(res.recorded).toBe(true);
    await env.setStatus(tryout.id, "idle");
    await tick();
    const check = ownerCheck(id);
    expect(check?.state).toBe("fail");
    expect(check?.detail).toContain("owner check 2");
    // An observation that repeats the scenario is withheld from the builder.
    expect(check?.detail).toContain(OBSERVATION_WITHHELD);
    expect(check?.detail).not.toContain(EXPORT);
    // A revise round went to the builder, without the scenario's wording.
    expect(item(id).attempts).toBe(1);
    const revise = env.messages.filter((m) => m.sessionId === builder).at(-1)?.text ?? "";
    expect(revise).toMatch(/owner_checks/);
    expect(revise).not.toContain(EXPORT);
    expect(revise).not.toContain(PASTE);

    // Each scenario keeps its last result, with the PR.
    const kept = env.factory.ownerChecks(env.project.id).checks;
    expect(kept.map((c) => c.last?.state)).toEqual(["pass", "fail"]);
    expect(kept[0]?.last?.prNumber).toBe(it0.pr?.number);
  });

  it("pass when every scenario passed", async () => {
    env = createFactoryEnv();
    withDevServer();
    ownerChecks(PASTE, EXPORT);
    const { id } = await approved();
    const tryout = env.repo
      .list()
      .find((s) => (s.workKey ?? "").startsWith(OWNER_CHECKS_WORK_KEY_PREFIX)) as { id: string };
    env.factory.submitOwnerChecks(env.repo.get(tryout.id), {
      results: [
        { number: 1, state: "pass", observation: "Worked." },
        { number: 2, state: "pass", observation: "A PDF downloaded." },
      ],
    });
    await tick();
    expect(ownerCheck(id)).toMatchObject({ state: "pass" });
  });

  it("reject results that skip a scenario", async () => {
    env = createFactoryEnv();
    withDevServer();
    ownerChecks(PASTE, EXPORT);
    await approved();
    const tryout = env.repo
      .list()
      .find((s) => (s.workKey ?? "").startsWith(OWNER_CHECKS_WORK_KEY_PREFIX)) as { id: string };
    expect(() =>
      env.factory.submitOwnerChecks(env.repo.get(tryout.id), {
        results: [{ number: 1, state: "pass", observation: "Worked." }],
      }),
    ).toThrow(/missing: 2/);
  });

  it("nudge a tryout that ends without results once, then fail as infrastructure", async () => {
    env = createFactoryEnv();
    withDevServer();
    ownerChecks(PASTE);
    const { id } = await approved();
    const tryout = env.repo
      .list()
      .find((s) => (s.workKey ?? "").startsWith(OWNER_CHECKS_WORK_KEY_PREFIX)) as { id: string };
    await env.setStatus(tryout.id, "idle");
    await tick();
    expect(env.messages.filter((m) => m.sessionId === tryout.id)).toHaveLength(1);
    await env.setStatus(tryout.id, "idle");
    later(2 * 60_000);
    await tick();
    expect(item(id).stage).toBe("failed");
    expect(item(id).failureKind).toBe("infrastructure");
    expect(item(id).attempts).toBe(0);
  });
});
