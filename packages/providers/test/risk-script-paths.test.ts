// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell scripts, not templates
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { levelAllows } from "../src/codex/policy";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/** Issue #153: paths a script builds from its own folder, in a project folder with a space. */

let ctx: RiskContext;
let top: string;
beforeAll(() => {
  top = realpathSync(mkdtempSync(join(tmpdir(), "codeden-paths-")));
  const cwd = join(top, "my repo");
  for (const dir of [".git", "scripts", "sub"]) mkdirSync(join(cwd, dir), { recursive: true });
  mkdirSync(join(top, "my"));
  writeFileSync(join(top, "evil.sh"), "echo hi\n");
  symlinkSync(join(top, "evil.sh"), join(cwd, "scripts/link.sh"));
  ctx = { cwd, platform: "linux", home: "/home/me", tempRoots: ["/tmp/x"], shell: "posix" };
  ctx.env = { HOME: "/home/me", SET_DIR: "/outside" };
});
afterAll(() => rmSync(top, { recursive: true, force: true }));

const asks = (command: string): boolean => {
  const found = classifyCommand(command, ctx);
  return found.risky && !levelAllows("auto", found);
};

/** Whether running `text` as `scripts/a.sh` asks: from the project, then by its full path. */
function script(text: string, command?: string): boolean[] {
  const file = join(ctx.cwd, "scripts/a.sh");
  writeFileSync(file, text);
  return [command ?? "bash scripts/a.sh", `bash "${file}"`].map(asks);
}

describe("a script's own folders (#153)", () => {
  it.each([
    // A space in the project's folder.
    'cd "$(dirname "$0")/.."\nmkdir -p dist',
    'HERE="$(cd "$(dirname "$0")" && pwd)"\necho x > "$HERE/log"\nrm -rf "$HERE"/out',
    'HERE=$(cd "$(dirname "$0")" && pwd)\necho x > "$HERE/log"',
    'HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." &>/dev/null && pwd -P)\nrm -rf "$HERE/x"',
    // Built from a variable that holds its folder.
    'HERE="$(cd "$(dirname "$0")" && pwd)"\nROOT="$(dirname "$HERE")"\nrm -rf "$ROOT/dist"',
    'HERE="$(cd "$(dirname "$0")" && pwd)"\nROOT="$(cd "$HERE/.." && pwd)"\ncd "$ROOT"\nmake',
    'SELF="$(realpath "$0")"\nrm -rf "$(dirname "$SELF")/out"',
    'SELF="$(readlink -f "${BASH_SOURCE[0]}")"\ncd "$(dirname "$SELF")"\nmake',
    // The repository's top folder.
    'ROOT="$(git rev-parse --show-toplevel)"\nrm -rf "$ROOT/dist"',
    'ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"\ncd "$ROOT"\nmake',
    'cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"\nmake',
    // Several values at once.
    'HERE="$(cd "$(dirname "$0")" && pwd)"\nD=sub\n[ -d x ] && D=scripts\nfor f in a b; do\n  rm -rf "$HERE/$D/$f"\ndone',
    // A setting's default.
    'HERE="$(cd "$(dirname "$0")" && pwd)"\nDATA="${DATA_DIR:-$HERE/data}"\nmkdir -p "$DATA"',
    'OUT_DIR="${OUT_DIR:-dist}"\nrm -rf "$OUT_DIR"',
  ])("doesn't ask: %s", (text) => {
    expect(script(text)).toEqual([false, false]);
  });

  it.each([
    'cd "$(dirname "$0")/../.."\nrm -rf x',
    'HERE="$(cd "$(dirname "$0")" && pwd)"\nROOT="$(dirname "$(dirname "$HERE")")"\nrm -rf "$ROOT/x"',
    'HERE="$(cd "$(dirname "$0")" && pwd)"\nROOT="$(cd "$HERE/../.." && pwd)"\nrm -rf "$ROOT/x"',
    'ROOT="$(git rev-parse --show-toplevel)"\nrm -rf "$ROOT/../x"',
    'cd /outside\nROOT="$(git rev-parse --show-toplevel)"\nrm -rf "$ROOT/x"',
    'git() { echo /outside; }\nROOT="$(git rev-parse --show-toplevel)"\nrm -rf "$ROOT/x"',
    'realpath() { echo /outside; }\nrm -rf "$(realpath "$0")"',
    'GIT_DIR=/outside/.git\nexport GIT_DIR\nROOT="$(git rev-parse --show-toplevel)"\nrm -rf "$ROOT/x"',
    // Clearly outside.
    'rm -rf "$HOME/x"',
    "echo x > ~/x",
    'D="$HOME/x"\nmkdir -p "$D/y"',
    'D=/etc\ncp a "$D/a"',
    // Only known when it runs.
    'rm -rf "$1"',
    'D="$(cat list)"\nrm -rf "$D"',
    'D=sub\nread D\nrm -rf "$D"',
    // One of several values is outside.
    'D=sub\n[ -d x ] && D=/outside\nfor f in a b; do\n  rm -rf "$D/$f"\ndone',
    'D=sub\n[ -d x ] && D=/outside\nE="$D/y"\nrm -rf "$E"',
    'D=sub\n[ -d x ] && D=/outside\nN=a\n[ -d y ] && N=b\nE="$D/$N"\nrm -rf "$E"',
    // Defaults that are outside, or that something may change.
    'D="${DATA_DIR:-/outside}"\nrm -rf "$D"',
    'D="${DATA_DIR:-$HOME/data}"\nmkdir -p "$D"',
    'D="${SET_DIR:-dist}"\nrm -rf "$D"',
    'source ./conf.sh\nD="${DATA_DIR:-dist}"\nrm -rf "$D"',
    'read -r DATA_DIR < x\nrm -rf "${DATA_DIR:-dist}"',
    'eval "$X"\nrm -rf "${DATA_DIR:-dist}"',
    'D="${DATA_DIR:-dist}"\nrm -rf "${D}/../../x"',
  ])("still asks: %s", (text) => {
    expect(script(text)).toEqual([true, true]);
  });

  it("still asks when the command line may change a default", () => {
    const text = 'rm -rf "${DATA_DIR:-dist}"';
    expect(script(text)[0]).toBe(false);
    for (const command of [
      "DATA_DIR=/outside bash scripts/a.sh",
      "export DATA_DIR=/outside; bash scripts/a.sh",
      "env 'DATA''_DIR=/outside' bash scripts/a.sh",
      "ex\\port DATA\\_DIR=/outside; bash scripts/a.sh",
      "'ex'port 'DATA'_DIR=/outside; bash scripts/a.sh",
    ]) {
      expect(script(text, command)[0], command).toBe(true);
    }
  });

  it("asks where a space would split a path in two", () => {
    const name = join(ctx.cwd, "scripts/a.sh");
    for (const text of [
      'rm -rf $(dirname "$0")/x',
      'HERE="$(cd "$(dirname "$0")" && pwd)"\nrm -rf $HERE/x',
      'HERE="$(cd "$(dirname "$0")" && pwd)"\nrm -rf $HERE',
      "cd $(dirname $0)\nrm -rf x",
    ]) {
      writeFileSync(name, text);
      expect(asks(`bash "${name}"`), text).toBe(true);
    }
    expect(asks("x='sub /outside'; rm -rf $x/y")).toBe(true);
    expect(asks("x='sub /outside'; rm -rf \"$x/y\"")).toBe(false);
  });

  it("follows a link to where the script is", () => {
    expect(asks('bash -c \'rm -rf "$(dirname "$(realpath scripts/link.sh)")/x"\'')).toBe(true);
  });
});

describe("installed tools and start-up files (#153)", () => {
  it.each([
    "~/.nvm/versions/node/v22.1.0/bin/node x.js",
    "~/.bun/bin/bun run x",
    "~/Library/pnpm/pnpm test",
    "~/.local/share/pnpm/pnpm test",
    "~/miniconda3/bin/python x.py",
    "~/miniforge3/envs/ml/bin/python x.py",
    "/opt/anaconda3/bin/python x.py",
    "/opt/homebrew/Cellar/node/22.1.0/bin/node x.js",
    "/usr/local/opt/openssl/bin/openssl version",
    "/home/linuxbrew/.linuxbrew/bin/rg x",
    "source ~/.zshrc",
    ". ~/.bashrc",
    'source "$HOME/.profile"',
    ". /etc/profile",
    "source ~/.cargo/env",
    ". ~/miniconda3/etc/profile.d/conda.sh",
    "bash --rcfile ~/.bashrc -i",
  ])("doesn't ask: %s", (command) => {
    expect(asks(command)).toBe(false);
  });

  it.each([
    "~/.nvm/evil",
    "~/.nvm/versions/node/v22/bin/../../../../../evil",
    "~/.bun/evil",
    "~/Library/evil",
    "~/miniconda3/evil",
    "~/miniconda3-x/bin/evil",
    "/opt/evil/bin/evil",
    "/opt/homebrew/Cellar/x/evil",
    "bash ~/.zshrc",
    "source ~/.zshrc.evil",
    "source ~/x/.zshrc",
    "source /outside/.bashrc",
    "echo 'rm -rf x' >> ~/.zshrc; source ~/.zshrc",
  ])("still asks: %s", (command) => {
    expect(asks(command)).toBe(true);
  });
});
