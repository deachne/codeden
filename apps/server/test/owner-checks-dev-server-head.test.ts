import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectDevServerAtHead } from "../src/services/factory/owner-checks";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

let env: FactoryEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const exec =
  (stdout: string, code = 0) =>
  async () => ({
    code,
    stdout,
    stderr: "",
    notFound: false,
    timedOut: false,
    path: null,
  });

describe("projectDevServerAtHead with a leftover tryout worktree (#32)", () => {
  it("uses the PR head's devServer, not an older worktree's", async () => {
    env = createFactoryEnv();
    const wt = join(env.dir, "old-tryout-wt");
    mkdirSync(join(wt, ".codeden"), { recursive: true });
    writeFileSync(
      join(wt, ".codeden", "project.json"),
      JSON.stringify({ devServer: { command: "pnpm dev:old", port: 5174 } }),
    );
    const got = await projectDevServerAtHead(env.project, {
      exec: exec(JSON.stringify({ devServer: { command: "pnpm dev:new", port: 5173 } })),
      head: "new-head",
      worktree: wt,
    });
    expect(got).toEqual({ command: "pnpm dev:new", port: 5173 });
  });

  it("reports no devServer when the new head removed it", async () => {
    env = createFactoryEnv();
    const wt = join(env.dir, "old-tryout-wt2");
    mkdirSync(join(wt, ".codeden"), { recursive: true });
    writeFileSync(
      join(wt, ".codeden", "project.json"),
      JSON.stringify({ devServer: { command: "pnpm dev:old", port: 5174 } }),
    );
    const got = await projectDevServerAtHead(env.project, {
      exec: exec(JSON.stringify({ name: "x" })),
      head: "new-head",
      worktree: wt,
    });
    expect(got).toBeUndefined();
  });
});
