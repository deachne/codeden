import { describe, expect, it } from "vitest";
import { levelAllows } from "../src/codex/policy";
import { classifyCommand, classifyRead, classifyWrite, type RiskContext } from "../src/policy/risk";

/**
 * Issue #152: writing `.git/config`, `.git/hooks/**`, or configuring git hooks/pagers/editors
 * via `git config` or `git -c` can plant commands that run outside CodeDen's approval flow on
 * later git commands. These must ask for approval.
 */

const posix: RiskContext = {
  cwd: "/work/repo",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  shell: "posix",
};
const win: RiskContext = {
  cwd: "C:\\work\\repo",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  shell: "powershell",
};

const asksAtAuto = (command: string, ctx: RiskContext = posix) => {
  const r = classifyCommand(command, ctx);
  return r.risky && !levelAllows("auto", r);
};

describe("git config and hooks protection (#152)", () => {
  it("asks for git config and git -c code-execution settings", () => {
    for (const command of [
      "git config core.hooksPath /outside/hooks",
      "git -c core.hooksPath=/outside/hooks commit -m x",
      "git -ccore.hooksPath=/outside/hooks commit -m x",
      "git --config-env=core.hooksPath=EVIL commit -m x",
      "git config core.pager 'sh -c id'",
      "git -c core.pager='sh -c id' log",
      "git config core.editor '/outside/edit.sh'",
      "git config core.sshCommand 'sh -c id'",
      "git config core.fsmonitor '/outside/mon.sh'",
      "git config filter.x.smudge 'sh -c id'",
      "git config alias.evil '!sh -c id'",
      "git -c alias.evil='!sh -c id' evil",
      "git config --local core.hooksPath ./hooks",
      "git config set core.hooksPath /outside/hooks",
      "git config --edit",
    ]) {
      expect(asksAtAuto(command), command).toBe(true);
    }
  });

  it("asks for shell writes to .git/config and .git/hooks/**", () => {
    for (const command of [
      "echo 'sh -c id' > .git/config",
      "sed -i s/a/b/ .git/config",
      "cp /outside/config .git/config",
      "echo '#!/bin/sh' > .git/hooks/pre-commit",
      "cp /outside/hook .git/hooks/",
      "tee .git/config < /tmp/cfg",
      "cd .git && echo x > config",
      "cd .git/hooks && echo x > post-checkout",
      `node -e "require('fs').writeFileSync('.git/config', 'x')"`,
      `python3 -c "open('.git/hooks/pre-commit','w').write('x')"`,
    ]) {
      expect(asksAtAuto(command), command).toBe(true);
    }
    expect(asksAtAuto("Set-Content -Path .git\\config -Value x", win)).toBe(true);
    expect(asksAtAuto("Copy-Item evil .git\\hooks\\pre-commit", win)).toBe(true);
  });

  it("flags direct writes to .git/config and .git/hooks/** via classifyWrite", () => {
    for (const file of [
      ".git/config",
      "/work/repo/.git/config",
      ".git/hooks/pre-commit",
      ".git/hooks/post-checkout",
      ".git/hooks",
      ".GIT/CONFIG",
    ]) {
      const verdict = classifyWrite(file, posix);
      expect(verdict.risky, file).toBe(true);
      expect(levelAllows("auto", verdict), file).toBe(false);
    }
    expect(classifyWrite(".git\\config", win).risky).toBe(true);
    expect(classifyWrite(".git\\hooks\\pre-commit", win).risky).toBe(true);
  });

  it("keeps harmless git commands and reads free", () => {
    for (const command of [
      'git config user.name "Alice"',
      'git config user.email "alice@example.com"',
      "git config core.quotepath false",
      "git config commit.gpgsign false",
      "git config --get user.name",
      "git config --get core.hooksPath",
      "git config --list",
      "git -c core.pager=cat log -3",
      "git -c core.autocrlf=false status",
      "git status",
      "git log",
      "cat .git/config",
      "ls .git/hooks",
    ]) {
      expect(classifyCommand(command, posix).risky, command).toBe(false);
    }
    expect(classifyRead(".git/config", posix).risky).toBe(false);
    expect(classifyWrite("src/config.ts", posix).risky).toBe(false);
    expect(classifyWrite(".gitignore", posix).risky).toBe(false);
  });
});
