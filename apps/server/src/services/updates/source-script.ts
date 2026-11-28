import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceUpdateState, SourceUpdateStatus } from "@codeden/contracts";
import { conflict, errorMessage } from "../errors";

/** Runs `git` with these arguments in `cwd`; resolves with its standard output. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;
/** Starts the script detached from the server, writing its output to `logFile`. */
export type ScriptSpawner = (script: string, logFile: string) => ChildProcess;

export interface SourceUpdateDeps {
  /** `settings.updates.sourceScript`. */
  script: () => string;
  /** Where the script's output goes (`<home>/logs`). */
  logDir: string;
  /** The git checkout this server was built from; found from the server's own files when absent. */
  repoRoot?: string | null;
  git?: GitRunner;
  spawn?: ScriptSpawner;
  now?: () => number;
  log?: (message: string) => void;
}

const TEN_MINUTES = 10 * 60_000;
const LOG_LINES = 12;

/**
 * The sidebar's Update button for a CodeDen run from a git checkout. It runs the script set in
 * `settings.updates.sourceScript` (say, pull + rebuild + restart) detached, so the script
 * outlives this server when it restarts CodeDen. It also counts the commits the checkout's
 * upstream branch has that it doesn't (`git fetch`, at most every 10 minutes). The browser
 * reloads when `bootId` changes, which means a new server answered.
 */
export class SourceUpdateService {
  readonly bootId = randomUUID();
  private state: SourceUpdateState = "idle";
  private startedAt: number | null = null;
  private error: string | null = null;
  private behind: number | null = null;
  private checkedAt: number | null = null;
  private checkError: string | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly repoRoot: string | null;

  constructor(private readonly deps: SourceUpdateDeps) {
    this.repoRoot =
      deps.repoRoot !== undefined ? deps.repoRoot : findGitRoot(fileURLToPath(import.meta.url));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The status; checks for new commits when asked, or when the last check is 10 minutes old. */
  async status(opts: { refresh?: boolean } = {}): Promise<SourceUpdateStatus> {
    const script = scriptPath(this.deps.script());
    if (script && this.repoRoot) {
      const stale = this.checkedAt === null || this.now() - this.checkedAt > TEN_MINUTES;
      if (opts.refresh || stale) await this.checkBehind();
    }
    return this.snapshot(script, script ? await scriptProblem(script) : null);
  }

  /** Start the script. Refused while it runs, or when it is missing or can't run. */
  async run(): Promise<SourceUpdateStatus> {
    const script = scriptPath(this.deps.script());
    if (!script) throw conflict("No update script is set. Add one in Settings > General.");
    const problem = await scriptProblem(script);
    if (problem) throw conflict(problem);
    if (this.state === "running") throw conflict("The update is already running.");
    const logFile = join(this.deps.logDir, "source-update.log");
    this.state = "running";
    this.startedAt = this.now();
    this.error = null;
    try {
      const child = (this.deps.spawn ?? spawnDetached)(script, logFile);
      child.once("error", (err) =>
        this.finished(`The update script could not start: ${errorMessage(err)}`),
      );
      child.once("exit", (code, signal) => {
        if (code === 0) {
          // Still here: the script finished without restarting CodeDen.
          this.state = "idle";
          this.behind = null;
          this.checkedAt = null;
          return;
        }
        const how =
          code === null ? `was stopped (${signal ?? "signal"})` : `stopped with code ${code}`;
        this.finished(`The update script ${how}. CodeDen kept running.${tailOf(logFile)}`);
      });
      child.unref();
    } catch (err) {
      this.finished(`The update script could not start: ${errorMessage(err)}`);
    }
    this.deps.log?.(`update script started: ${script}`);
    return this.snapshot(script, null);
  }

  private finished(error: string): void {
    this.state = "failed";
    this.error = error;
    this.deps.log?.(error);
  }

  private checkBehind(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const root = this.repoRoot as string;
    const git = this.deps.git ?? runGit;
    this.inFlight = (async () => {
      try {
        await git(["fetch", "--quiet"], root);
        const out = await git(["rev-list", "--count", "HEAD..@{upstream}"], root);
        const n = Number.parseInt(out.trim(), 10);
        this.behind = Number.isFinite(n) && n >= 0 ? n : null;
        this.checkError = null;
      } catch (err) {
        this.checkError = `Couldn't check for new changes: ${firstLine(errorMessage(err))}`;
      } finally {
        this.checkedAt = this.now();
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  private snapshot(script: string | null, problem: string | null): SourceUpdateStatus {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    return {
      configured: script !== null,
      scriptPath: script,
      problem,
      behind: script ? this.behind : null,
      checkedAt: iso(this.checkedAt),
      checkError: this.checkError,
      state: this.state,
      startedAt: iso(this.startedAt),
      error: this.error,
      bootId: this.bootId,
    };
  }
}

/** The setting with `~` expanded, or null when empty. */
export function scriptPath(setting: string): string | null {
  const value = setting.trim();
  if (!value) return null;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? resolve(value) : null;
}

/** Why `script` can't run, in plain words, or null. */
export async function scriptProblem(script: string): Promise<string | null> {
  let isFile: boolean;
  try {
    isFile = statSync(script).isFile();
  } catch {
    return `The update script ${script} wasn't found on this computer.`;
  }
  if (!isFile) return `${script} is a folder, not a script.`;
  try {
    await access(script, constants.X_OK);
  } catch {
    return `${script} isn't allowed to run. In Terminal, run: chmod +x "${script}"`;
  }
  return null;
}

/** The nearest folder at or above `from` that holds `.git`, or null. */
export function findGitRoot(from: string): string | null {
  let dir = dirname(from);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => (err ? fail(new Error(stderr.trim() || err.message)) : done(stdout)),
    );
  });
}

/**
 * Start the script in its own process group with output to `logFile`, so it keeps going when
 * the server it restarts stops. CodeDen's own `CODEDEN_*` variables stay out, as if it were run
 * from Terminal.
 */
function spawnDetached(script: string, logFile: string): ChildProcess {
  const fd = openSync(logFile, "w");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("CODEDEN_")),
  );
  try {
    return spawn(script, [], {
      cwd: dirname(script),
      detached: true,
      stdio: ["ignore", fd, fd],
      env,
    });
  } finally {
    closeSync(fd);
  }
}

function tailOf(logFile: string): string {
  try {
    const lines = readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-LOG_LINES);
    return lines.length && lines[0] ? `\n\nLast lines of its output:\n${lines.join("\n")}` : "";
  } catch {
    return "";
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}
