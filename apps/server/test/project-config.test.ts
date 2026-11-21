import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec } from "../src/services/exec";
import {
  parseProjectConfig,
  projectDefaultProvider,
  readProjectConfigFromGit,
} from "../src/services/projects/project-config";
import { removeTree } from "./support/remove-tree";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-pcfg-"));
});
afterEach(() => removeTree(dir));

const writeConfig = (text: string) => {
  mkdirSync(join(dir, ".codeden"), { recursive: true });
  writeFileSync(join(dir, ".codeden", "project.json"), text);
};

describe("readProjectConfigFromGit", () => {
  it("parses valid and invalid json with parseProjectConfig", () => {
    expect(
      parseProjectConfig('{ "devServer": { "command": "pnpm dev", "port": 5173 } }')?.devServer,
    ).toEqual({ command: "pnpm dev", port: 5173 });
    expect(parseProjectConfig("not json")).toBeNull();
  });

  it("reads and parses .codeden/project.json from git show", async () => {
    const fakeExec: Exec = async (_cmd, args) => {
      expect(args).toEqual(["-C", dir, "show", "head-sha:.codeden/project.json"]);
      return {
        code: 0,
        stdout: JSON.stringify({ devServer: { command: "pnpm dev", port: 5173 } }),
        stderr: "",
        notFound: false,
        timedOut: false,
        path: null,
      };
    };
    const config = await readProjectConfigFromGit(fakeExec, dir, "head-sha");
    expect(config?.devServer).toEqual({ command: "pnpm dev", port: 5173 });
  });

  it("returns null when git show fails or returns invalid json", async () => {
    const failingExec: Exec = async () => ({
      code: 1,
      stdout: "",
      stderr: "fatal: path not found",
      notFound: false,
      timedOut: false,
      path: null,
    });
    expect(await readProjectConfigFromGit(failingExec, dir, "missing-ref")).toBeNull();

    const invalidExec: Exec = async () => ({
      code: 0,
      stdout: "not json",
      stderr: "",
      notFound: false,
      timedOut: false,
      path: null,
    });
    expect(await readProjectConfigFromGit(invalidExec, dir, "bad-json")).toBeNull();
  });
});

describe(".codeden/project.json defaultProvider", () => {
  it("is the project's default unless the project sets its own", () => {
    expect(projectDefaultProvider({ defaultProvider: null, path: dir })).toBeNull();
    writeConfig('{ "defaultProvider": "codex", "setup": ["pnpm install"] }');
    expect(projectDefaultProvider({ defaultProvider: null, path: dir })).toBe("codex");
    expect(projectDefaultProvider({ defaultProvider: "claude", path: dir })).toBe("claude");
  });

  it("ignores invalid files", () => {
    writeConfig("{ not json");
    expect(projectDefaultProvider({ defaultProvider: null, path: dir })).toBeNull();
    writeConfig('{ "defaultProvider": "" }');
    expect(projectDefaultProvider({ defaultProvider: null, path: dir })).toBeNull();
  });
});
