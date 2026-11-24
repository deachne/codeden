import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { levelAllows } from "../src/codex/policy";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/**
 * Issue #153: running external script files (`source`, `.`, `bash <file>`, `bash < <file>`),
 * invoking binaries by path outside the worktree (directly or via `find -exec`), and ripgrep's
 * `--pre` preprocessor must ask for approval instead of running freely at Auto.
 */

const posix: RiskContext = {
  cwd: "/work/repo",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  shell: "posix",
};

const action = (command: string, ctx: RiskContext = posix) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.action : null;
};

describe("script files, external binaries and rg --pre (#153)", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("asks when sourcing or running a script file outside the worktree", () => {
    for (const command of [
      "source /home/me/evil.sh",
      ". /home/me/evil.sh",
      "bash /home/me/evil.sh",
      "bash < /home/me/evil.sh",
      "sh /home/me/evil.sh",
      "zsh /home/me/evil.sh",
      "bash -e /home/me/evil.sh",
      "bash -- /home/me/evil.sh",
      "bash ~/evil.sh",
      "source ../outside/evil.sh",
    ]) {
      const verdict = classifyCommand(command, posix);
      expect(verdict, command).toMatchObject({ risky: true, action: "outside_worktree" });
      expect(levelAllows("auto", verdict), command).toBe(false);
      expect(levelAllows("full", verdict), command).toBe(false);
    }
  });

  it("asks for the same file given another way", () => {
    for (const command of [
      "bash -s < /outside/script",
      "bash -s -- arg < /outside/script",
      "sh -es < /outside/script",
      "cat x | bash -s < /outside/script",
      "bash - /home/me/evil.sh",
      "bash -oe pipefail /home/me/evil.sh",
      "bash -C /home/me/evil.sh",
      "zsh -oextendedglob /home/me/evil.sh",
      "zsh -ocorrect /home/me/evil.sh",
      "source /dev/stdin < /outside/script",
      "bash $HOME/evil.sh",
      'bash "$HOME/evil.sh"',
      "source $" + "{HOME}/evil.sh",
      "bash ~me/evil.sh",
      "bash < ~/evil.sh",
      "bash -s < $HOME/evil.sh",
      "$HOME/evil.sh",
      '"$HOME"/evil.sh',
      "$" + "{HOME}/evil.sh",
      "$" + "{HOME%/}/evil.sh",
      "~me/evil.sh",
      "~/evil.sh",
      "cd ~ && ./evil.sh",
      "src/../../evil.sh",
      "find . -exec $HOME/evil.sh {} +",
      "rg x --pre $HOME/evil.sh",
    ]) {
      const verdict = classifyCommand(command, posix);
      expect(verdict, command).toMatchObject({ risky: true, action: "outside_worktree" });
    }
    for (const command of [
      "bash -s < ./scripts/a.sh",
      "bash -eo pipefail ./scripts/a.sh",
      "bash -C ./scripts/a.sh",
      "node_modules/.bin/vitest run",
      "echo $HOME/x",
    ]) {
      expect(action(command), command).toBeNull();
    }
  });

  it("asks when sourcing an unreadable script file inside the worktree", () => {
    for (const command of ["source ./local.sh", ". ./local.sh"]) {
      const verdict = classifyCommand(command, posix);
      expect(verdict.risky, command).toBe(true);
      expect(levelAllows("auto", verdict), command).toBe(false);
    }
  });

  it("classifies the contents of an existing script file inside the worktree", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-script-test-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "evil.sh"), "rm -rf /outside/data\n");
    writeFileSync(join(dir, "ok.sh"), "echo hello\n");
    const realCtx: RiskContext = { ...posix, cwd: dir };
    expect(action("bash ./evil.sh", realCtx)).toBe("outside_worktree");
    expect(action("bash < ./evil.sh", realCtx)).toBe("outside_worktree");
    expect(action("source ./evil.sh", realCtx)).toBe("outside_worktree");
    expect(action("bash ./ok.sh", realCtx)).toBeNull();
  });

  it("asks when running an external binary directly or through find -exec", () => {
    for (const command of [
      "/outside/x",
      "~/evil.sh",
      "../outside/x",
      "./../outside/x",
      "find . -exec /outside/x {} ;",
      "find . -exec /outside/x {} \\;",
      "find . -exec sh -c 'cp README.md /outside/' ;",
      "find . -exec sh -c 'cp README.md /outside/' \\;",
    ]) {
      expect(action(command), command).toBe("outside_worktree");
    }
  });

  it("asks when rg --pre runs an external or risky program", () => {
    for (const command of [
      "rg pattern --pre /outside/pre.sh",
      "rg pattern --pre=/outside/pre.sh",
      "rg --pre /outside/pre.sh pattern src/",
      "rg --pre ~/pre.sh pattern",
      "rg pattern --pre bash /outside",
    ]) {
      expect(action(command), command).toBe("outside_worktree");
    }
  });

  it("keeps harmless controls and allowed worktree scripts free", () => {
    for (const command of [
      "find . -name '*.ts'",
      "rg pattern src/",
      "rg --pre-glob '*.gz' pattern src/",
      "bash -c 'echo hi'",
      "curl -s https://api.x/items | bash ./scripts/ingest.sh",
      "./scripts/build.sh",
      "/bin/zsh -lc 'ls'",
      "/usr/bin/env node --version",
    ]) {
      expect(action(command), command).toBeNull();
    }
  });
});
