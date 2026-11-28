import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceError } from "../src/services/errors";
import {
  type GitRunner,
  type ScriptSpawner,
  SourceUpdateService,
  scriptPath,
} from "../src/services/updates/source-script";

let dir: string;
let script: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-source-update-"));
  script = join(dir, "update.sh");
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  chmodSync(script, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), { unref() {} }) as unknown as ChildProcess;
}

function service(opts: { setting?: string; git?: GitRunner; spawn?: ScriptSpawner } = {}) {
  return new SourceUpdateService({
    script: () => opts.setting ?? script,
    logDir: dir,
    repoRoot: dir,
    git: opts.git ?? (async (args) => (args[0] === "rev-list" ? "3\n" : "")),
    spawn: opts.spawn ?? (() => fakeChild()),
  });
}

describe("SourceUpdateService", () => {
  it("expands ~ and ignores relative paths", () => {
    expect(scriptPath("")).toBeNull();
    expect(scriptPath("~/x/update.sh")).toBe(join(homedir(), "x/update.sh"));
    expect(scriptPath("update.sh")).toBeNull();
  });

  it("hides the button with no script, and counts new changes with one", async () => {
    expect((await service({ setting: "" }).status()).configured).toBe(false);
    const status = await service().status();
    expect(status).toMatchObject({ configured: true, problem: null, behind: 3, state: "idle" });
  });

  it("says plainly when the script is missing and refuses to run it", async () => {
    const s = service({ setting: join(dir, "nope.sh") });
    expect((await s.status()).problem).toMatch(/wasn't found/);
    await expect(s.run()).rejects.toBeInstanceOf(ServiceError);
  });

  it("keeps going when the check for new changes fails", async () => {
    const s = service({
      git: async () => {
        throw new Error("Could not resolve host: github.com");
      },
    });
    expect(await s.status()).toMatchObject({ behind: null, checkError: expect.any(String) });
  });

  it("runs once at a time and reports a failed run with its output", async () => {
    const child = fakeChild();
    const s = service({ spawn: () => child });
    expect((await s.run()).state).toBe("running");
    await expect(s.run()).rejects.toThrow(/already running/);
    writeFileSync(join(dir, "source-update.log"), "Installing...\nbuild failed\n");
    child.emit("exit", 1, null);
    const status = await s.status();
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/code 1[\s\S]*build failed/);
  });
});
