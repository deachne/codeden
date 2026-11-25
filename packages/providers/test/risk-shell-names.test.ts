// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell scripts, not templates
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/** Issue #153: other ways to name the shell that runs a script, or to hand it one. */

let ctx: RiskContext;
beforeAll(() => {
  const cwd = mkdtempSync(join(tmpdir(), "codeden-shells-"));
  writeFileSync(join(cwd, "ok.sh"), "echo hi\n");
  writeFileSync(join(cwd, "evil.sh"), "rm -rf /outside\n");
  ctx = { cwd, platform: "linux", home: "/home/me", tempRoots: ["/tmp/x"], shell: "posix" };
});
afterAll(() => rmSync(ctx.cwd, { recursive: true, force: true }));

const action = (command: string) => {
  const verdict = classifyCommand(command, ctx);
  return verdict.risky ? verdict.action : null;
};

describe("shells by other names (#153)", () => {
  it.each([
    "$SHELL /outside/x",
    '"$SHELL" /outside/x',
    "${SHELL} /outside/x",
    "${SHELL:-/bin/sh} /outside/x",
    "$BASH /outside/x",
    '"${BASH}" /outside/x',
    "$BASH < /outside/x",
    "$SHELL evil.sh",
    "$SHELL -c 'rm -rf /outside'",
    "nohup $SHELL /outside/x",
    ...["csh", "tcsh", "rbash", "yash", "rksh", "mksh"].flatMap((shell) => [
      `${shell} /outside/x`,
      `${shell} < /outside/x`,
      `${shell} evil.sh`,
      `${shell} -c 'rm -rf /outside'`,
      `echo 'rm -rf /outside' | ${shell}`,
    ]),
    "bash --rcfile /outside/x",
    "bash --init-file /outside/x -i",
    "bash -rcfile /outside/x",
    "bash --rcfile /outside/x -ic true",
    "bash --norc --rcfile /outside/x ok.sh",
    "bash --rcfile evil.sh",
    "bash -norc /outside/x",
    "bash -login /outside/x",
    "(bash) < /outside/x",
    "(cd .; bash) < ../x",
    "(bash) < evil.sh",
    "(bash; true) < ~/x",
    "{ bash; } < /outside/x",
    "for i in 1 2; do bash; done < /outside/x",
    "f() { bash; }; f < /outside/x",
    "bash -c bash < /outside/x",
    "eval bash < /outside/x",
  ])("asks: %s", (command) => {
    expect(action(command)).toBe("outside_worktree");
  });

  it("asks when what a group reads is only known when it runs", () => {
    expect(action('(bash) < "$X"')).not.toBeNull();
    expect(action("(bash) < ~me/x")).not.toBeNull();
  });

  it.each([
    "$SHELL ok.sh",
    "$SHELL -c 'echo hi'",
    "echo $SHELL",
    "tcsh ok.sh",
    "bash --rcfile ok.sh",
    "bash --norc ok.sh",
    "bash -norc ok.sh",
    "bash --login -c 'echo hi'",
    "bash ok.sh --rcfile /outside/x",
    "(bash) < ok.sh",
    "{ bash; } < ok.sh",
    "(wc -l) < /outside/x",
    "while read -r x; do bash ok.sh; done < list.txt",
    "bash -c 'wc -l' < /outside/x",
  ])("doesn't ask: %s", (command) => {
    expect(action(command)).toBeNull();
  });
});
