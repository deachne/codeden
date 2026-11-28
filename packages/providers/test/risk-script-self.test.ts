// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell scripts, not templates
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { levelAllows } from "../src/codex/policy";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/** Issue #153: what running scripts doesn't ask about, and what still does. */

let ctx: RiskContext;
beforeAll(() => {
  const cwd = mkdtempSync(join(tmpdir(), "codeden-self-"));
  mkdirSync(join(cwd, "scripts"));
  ctx = { cwd, platform: "linux", home: "/home/me", tempRoots: ["/tmp/x"], shell: "posix" };
});
afterAll(() => rmSync(ctx.cwd, { recursive: true, force: true }));

const asks = (command: string): boolean => {
  const found = classifyCommand(command, ctx);
  return found.risky && !levelAllows("auto", found);
};

/** Whether running `text` as `scripts/a.sh` asks. */
function script(text: string, command = "bash scripts/a.sh"): boolean {
  writeFileSync(join(ctx.cwd, "scripts/a.sh"), text);
  return asks(command);
}

describe("a script that uses its own folder (#153)", () => {
  it.each([
    'cd "$(dirname "$0")/.."\nmkdir -p dist\necho hi > dist/out.txt',
    "cd $(dirname $0)\nrm -rf build",
    'cd "$(dirname -- "${BASH_SOURCE[0]}")" && npm run build',
    'cd "${0%/*}/.." && touch done',
    'cd "${BASH_SOURCE%/*}/.."\nmake',
    'ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\ncd "$ROOT"\nrm -rf "$ROOT/dist"',
    'DIR="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd)"\necho x > "${DIR}/log"',
    'DIR="$( cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" &> /dev/null && pwd -P )"\necho > $DIR/y',
    'export HERE="$(dirname "$0")"\nwork() {\n  tar -xf a.tar -C "$HERE"\n}\nwork',
    'grep "^# " "$0"',
  ])("doesn't ask: %s", (text) => {
    expect(script(text)).toBe(false);
  });

  it("reads it the same in other shells, sourced, and through an absolute path", () => {
    const text = 'D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\necho x > "$D/log"';
    for (const run of [
      "sh scripts/a.sh",
      "zsh scripts/a.sh",
      "source scripts/a.sh",
      `bash ${join(ctx.cwd, "scripts/a.sh")}`,
      "cd scripts && bash ./a.sh",
    ]) {
      expect(script(text, run), run).toBe(false);
    }
  });

  it.each([
    // Out of the worktree from its own folder.
    'cd "$(dirname "$0")/../.."\nrm -rf x',
    'ROOT="$(cd "$(dirname "$0")/../.." && pwd)"\nrm -rf "$ROOT/x"',
    'echo x > "${BASH_SOURCE%/*}/../../x"',
    // `$0` is relative: after a `cd` it is another folder.
    'cd ..\ncd "$(dirname "$0")"\ncd ..\nrm -rf x',
    'cd /outside\nD="$(cd "$(dirname "$0")" && pwd)"\nrm -rf "$D/x"',
    'f() {\n  D="$(cd "$(dirname "$0")" && pwd)"\n  rm -rf "$D/x"\n}\ncd /outside\nf',
    'for i in 1 2; do\n  D="$(cd "$(dirname "$0")" && pwd)"\n  rm -rf "$D/x"\n  cd /outside\ndone',
    // What it means is changed.
    'dirname() { echo /outside; }\ncd "$(dirname "$0")"\nrm -rf x',
    'BASH_ARGV0=/outside/x\ncd "$(dirname "$0")"\nrm -rf x',
    // A folder that isn't there leaves the variable empty.
    'D="$(cd "$(dirname "$0")/nope" && pwd)"\nrm -rf "$D/x"',
    // Not its own folder.
    'cd "$(dirname "$1")"\nrm -rf x',
    'rm -rf "$1"',
  ])("still asks: %s", (text) => {
    expect(script(text)).toBe(true);
  });

  it("still asks where a shell leaves BASH_SOURCE empty", () => {
    expect(script('rm -rf "${BASH_SOURCE%/*}/lib"', "sh scripts/a.sh")).toBe(true);
    expect(script('cd "$(dirname "$0")"\nrm -rf x', "source scripts/a.sh")).toBe(true);
  });
});

describe("tools and set-up files (#153)", () => {
  it.each([
    "/opt/homebrew/opt/node@22/bin/node x.js",
    "/opt/homebrew/bin/rg x",
    "/usr/local/go/bin/go build",
    "/usr/libexec/java_home -v 17",
    "/Applications/Docker.app/Contents/Resources/bin/docker ps",
    "~/.local/bin/uv --version",
    "~/.cargo/bin/cargo build",
    "bash -n /home/me/x.sh",
    "zsh -n ./x.sh",
    "bash < /dev/null",
    "source ~/.nvm/nvm.sh",
    'export NVM_DIR="$HOME/.nvm"\n[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"',
    "source .venv/bin/activate && python x.py",
    ". venv/bin/activate",
    "source ~/.virtualenvs/app/bin/activate",
  ])("doesn't ask: %s", (command) => {
    expect(asks(command)).toBe(false);
  });

  it.each([
    "source /home/me/evil.sh",
    ". /home/me/evil.sh",
    "bash /home/me/evil.sh",
    "bash < /home/me/evil.sh",
    "find . -exec /outside/x {} ;",
    "rg pattern --pre /outside/pre.sh",
    "/Applications/../home/me/evil",
    "/usr/libexec/../../home/me/evil",
    "~/.local/bin/../../evil",
    "~/.local/evil",
    "/opt/homebrew/opt/x/evil",
    "bash -n +n /home/me/evil.sh",
    "bash -ni /home/me/evil.sh",
    "bash < /dev/null /home/me/evil.sh",
    "bash < ./ok.sh /home/me/evil.sh",
    "source ~/.nvm/evil.sh",
    "bash ~/.nvm/nvm.sh",
    "source /outside/.nvm/nvm.sh",
    "source /outside/.venv/bin/activate",
    'read NVM_DIR < x; . "$NVM_DIR/nvm.sh"',
    "source ./local.sh",
  ])("still asks: %s", (command) => {
    expect(asks(command)).toBe(true);
  });

  it("reads a virtualenv's file that is there", () => {
    mkdirSync(join(ctx.cwd, ".venv/bin"), { recursive: true });
    const file = join(ctx.cwd, ".venv/bin/activate");
    writeFileSync(file, 'VIRTUAL_ENV="/x/.venv"\nPATH="$VIRTUAL_ENV/bin:$PATH"\nexport PATH\n');
    expect(asks("source .venv/bin/activate")).toBe(false);
    writeFileSync(file, "rm -rf /outside\n");
    expect(asks("source .venv/bin/activate")).toBe(true);
    rmSync(join(ctx.cwd, ".venv"), { recursive: true });
  });
});
