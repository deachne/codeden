import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { levelAllows } from "../src/codex/policy";
import { classifyCommand } from "../src/policy/risk";
import { TOO_LARGE, WORK_LIMITS, Work } from "../src/policy/script-work";
import { braceAlternatives } from "../src/policy/secrets";

/** Issue #153: reading the scripts a command runs takes bounded work, however they are written. */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The verdict on `bash ./a.sh` in a worktree holding `files`. */
function verdict(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "codeden-work-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return classifyCommand("bash ./a.sh", {
    cwd: dir,
    platform: "linux",
    home: "/home/me",
    tempRoots: ["/tmp"],
    shell: "posix",
  });
}

const times = (n: number, line: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => line(i));

/** Each of these took minutes, hours or all the memory before. */
const BOUND = 20_000;

describe("bounded work on scripts (#153)", () => {
  it("stops at a script that fans out, and asks at Full too", { timeout: BOUND }, () => {
    const found = verdict({ "a.sh": "bash ./a.sh\n".repeat(60) });
    expect(found).toEqual(TOO_LARGE);
    expect(levelAllows("full", found)).toBe(false);
    const calls = (to: string) => `bash ./${to}.sh\necho hi\n`.repeat(60);
    expect(
      verdict({ "a.sh": calls("b"), "b.sh": calls("c"), "c.sh": calls("d"), "d.sh": "ls\n" }),
    ).toEqual(TOO_LARGE);
  });

  it("asks rather than skip what comes after the budget", () => {
    const padding = "echo x\n".repeat(WORK_LIMITS.commands);
    expect(verdict({ "a.sh": `${padding}rm -rf /outside\n` })).toEqual(TOO_LARGE);
    expect(verdict({ "a.sh": "echo x\n".repeat(1000) }).risky).toBe(false);
  });

  it("expands many brace groups without multiplying them", { timeout: BOUND }, () => {
    const many = "{a,b}".repeat(60);
    expect(braceAlternatives(many)).toHaveLength(64);
    const perl = `{ push(@x, [1,2]); s{a,b}{c,d}; %h = (k, {a,1}); } `.repeat(60);
    const found = verdict({
      "a.sh": `scan='${perl}'\nperl -e "$scan"\necho ${many}\ncat ${many}\n`,
    });
    expect(found.risky).toBe(false);
    for (const word of [`{${",".repeat(60_000)}`, "{,".repeat(30_000), "{a,b}".repeat(12_000)]) {
      verdict({ "a.sh": `cat ${word}\n` });
    }
  });

  it("gives the same words as a shell for ordinary braces", () => {
    expect(braceAlternatives("~/.ssh/{id_rsa,x}")).toEqual(["~/.ssh/id_rsa", "~/.ssh/x"]);
    expect(braceAlternatives("{a,b}{c,d}")).toEqual(["ac", "ad", "bc", "bd"]);
    expect(braceAlternatives("{a,{b,c}}/{z}")).toEqual(["a/{z}", "b/{z}", "a/{z}", "c/{z}"]);
    expect(braceAlternatives("{x}{{a,b}")).toEqual(["{x}{a", "{x}{b"]);
    expect(braceAlternatives("{}")).toEqual(["{}"]);
  });

  it("bounds variables, functions and nesting that multiply", { timeout: BOUND }, () => {
    const doubling = ["v0=xx", ...times(60, (i) => `v${i + 1}=$v${i}$v${i}`), "echo $v60"];
    verdict({ "a.sh": doubling.join("\n") });
    const spread = `${"echo $x $(".repeat(40)}ls${")".repeat(40)}`;
    verdict({ "a.sh": `${times(8, (i) => `x=${i}`).join("\n")}\n${spread}\n` });
    const names = times(14, (i) => `f${i}`);
    const functions = names.map((f) => `${f}() {\n${names.join("\n")}\n}`);
    expect(verdict({ "a.sh": `${functions.join("\n")}\nf0\n` })).toEqual(TOO_LARGE);
    expect(verdict({ "a.sh": `${"(".repeat(60_000)}\n` })).toEqual(TOO_LARGE);
  });

  it("counts bytes, and time from the first script read", () => {
    let now = 0;
    const work = new Work({ commands: 100, bytes: 10, ms: 5 }, () => now);
    now = 1000;
    expect(work.command()).toBe(true);
    expect(work.script(10)).toBe(true);
    now = 1005;
    expect(work.command()).toBe(true);
    now = 1006;
    expect(work.command()).toBe(false);
    expect(new Work({ commands: 100, bytes: 10, ms: 5 }).script(11)).toBe(false);
  });
});
