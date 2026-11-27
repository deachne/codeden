import { mostSevere, type RiskAssessment, risky, SAFE } from "./assessment";
import { commandWrite } from "./command-writes";
import { type PathContext, resolveAgainst } from "./paths";
import type { SimpleCommand } from "./shell";

/** What the git rules know about the session. */
export interface GitContext {
  /** The branch the session owns (SessionOptions.ownBranch). */
  ownBranch?: string;
  /** The branch checked out in the worktree, read when needed. */
  currentBranch?: () => string | undefined;
  /** True when the command runs in the session's worktree (not `cd`'d or `-C`'d elsewhere). */
  inWorktree: boolean;
}

/** Git global options that take the next word as their value. */
const GLOBAL_VALUED = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);

/**
 * Git rules of the risk classifier (§11.2): force pushes, deleting refs, global config,
 * `-c` overrides and repo-local `git config` writes that can execute code or hooks. `args`
 * keep their case (`-D` is not `-d`, branch names are case-sensitive).
 */
export function classifyGit(
  args: string[],
  ctx: GitContext = { inWorktree: false },
): RiskAssessment {
  const found: RiskAssessment[] = [];
  // Scan global options like `-C dir` / `-c k=v`; another directory is not the worktree.
  let i = 0;
  let elsewhere = false;
  while (i < args.length && args[i]?.startsWith("-")) {
    const option = args[i] as string;
    if (option === "-C" || option.startsWith("--git-dir") || option.startsWith("--work-tree")) {
      elsewhere = true;
    }
    const inlineC = /^-c(.+)$/s.exec(option)?.[1];
    const inlineEnv = /^--config-env=(.+)$/s.exec(option)?.[1];
    if (option === "-c" || inlineC !== undefined) {
      const setting = inlineC ?? args[i + 1] ?? "";
      const risk = classifyConfigOverride(setting, false);
      if (risk) found.push(risk);
    } else if (option === "--config-env" || inlineEnv !== undefined) {
      const setting = inlineEnv ?? args[i + 1] ?? "";
      const risk = classifyConfigOverride(setting, true);
      if (risk) found.push(risk);
    }
    i += GLOBAL_VALUED.has(option) ? 2 : 1;
  }
  const sub = args[i]?.toLowerCase();
  const raw = args.slice(i + 1);
  const rest = raw.map((a) => a.toLowerCase());
  if (sub === "push") {
    found.push(classifyPush(raw, { ...ctx, inWorktree: ctx.inWorktree && !elsewhere }));
  } else if (sub === "branch" && deletesUnmerged(raw)) {
    found.push(risky("git_destructive", "Deletes a branch with unmerged work (-D)"));
  } else if (sub === "tag" && rest.some((a) => a === "-d" || a === "--delete")) {
    found.push(risky("git_destructive", "Deletes a tag"));
  } else if (sub === "update-ref" && rest.includes("-d")) {
    found.push(risky("git_destructive", "Deletes a ref"));
  } else if (sub === "config" && writesConfig(rest)) {
    if (rest.includes("--global") || rest.includes("--system")) {
      found.push(risky("outside_worktree", "Changes global git configuration"));
    } else {
      found.push(classifyLocalConfig(raw, rest));
    }
  }
  return mostSevere(found);
}

/**
 * `git branch` deleting without the merged check: `-D`, or `-d`/`--delete` with `--force`.
 * A plain `-d` refuses to delete unmerged work, so it is safe.
 */
function deletesUnmerged(args: string[]): boolean {
  const short = args.filter((a) => /^-[a-zA-Z]+$/.test(a));
  if (short.some((a) => a.includes("D"))) return true;
  const deletes = args.includes("--delete") || short.some((a) => a.includes("d"));
  const force = args.includes("--force") || short.some((a) => a.includes("f"));
  return deletes && force;
}

/** `git push` options that take the next word as their value. */
const PUSH_VALUED = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/**
 * Force pushes and remote deletions ask. A force push with a lease (`--force-with-lease`) of
 * the session's own branch doesn't: it only rewrites the session's own work, and the lease
 * refuses if someone else pushed there since.
 */
function classifyPush(args: string[], ctx: GitContext): RiskAssessment {
  const flags = args.filter((a) => a.startsWith("-")).map((a) => a.toLowerCase());
  const operands = args.filter((a, i) => !a.startsWith("-") && !PUSH_VALUED.has(args[i - 1] ?? ""));
  if (operands.some((a) => a.startsWith("+") && a.length > 1)) {
    return risky("git_destructive", "Force-pushes a refspec");
  }
  if (
    flags.includes("--delete") ||
    flags.includes("-d") ||
    operands.some((a) => a.startsWith(":") && a.length > 1)
  ) {
    return risky("git_destructive", "Deletes a remote branch");
  }
  const hard = flags.some((a) => a === "--force" || a === "--mirror" || /^-[a-z]*f[a-z]*$/.test(a));
  const lease = flags.some((a) => a.startsWith("--force-with-lease"));
  if (hard || (lease && !pushesOwnBranch(flags, operands.slice(1), ctx))) {
    return risky("git_destructive", "Force-pushes, which can overwrite remote history");
  }
  return SAFE;
}

/** True when every ref the push updates is the session's own branch. */
function pushesOwnBranch(flags: string[], refspecs: string[], ctx: GitContext): boolean {
  const own = ctx.ownBranch;
  if (!own || !ctx.inWorktree) return false;
  if (flags.some((a) => ["--all", "--branches", "--tags", "--mirror", "--prune"].includes(a))) {
    return false;
  }
  const current = () => ctx.currentBranch?.();
  if (refspecs.length === 0) return current() === own;
  return refspecs.every((spec) => {
    const [src = "", dst] = spec.split(":");
    const target = (dst ?? (src === "HEAD" || src === "@" ? current() : src))?.replace(
      /^refs\/heads\//,
      "",
    );
    return target === own;
  });
}

/** `git config` options and subcommands that change the configuration. */
const CONFIG_WRITES = new Set([
  "--unset",
  "--unset-all",
  "--add",
  "--replace-all",
  "--edit",
  "-e",
  "--rename-section",
  "--remove-section",
  "set",
  "unset",
  "edit",
  "rename-section",
  "remove-section",
]);
/** `git config` options and subcommands that only read. */
const CONFIG_READS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--get-color",
  "--get-colorbool",
  "--list",
  "-l",
  "get",
  "list",
]);
/** `git config` options that take the next word as their value. */
const CONFIG_VALUED = new Set(["--type", "--default", "--file", "-f", "--blob", "--comment"]);

/**
 * True when `git config <rest>` changes something: a writing option or subcommand, or a name
 * and a value (`git config --global user.name x`). A bare name reads it.
 */
export function writesConfig(rest: string[]): boolean {
  const positional = rest.filter(
    (a, i) => !a.startsWith("-") && !CONFIG_VALUED.has(rest[i - 1] ?? ""),
  );
  // Subcommands (`git config get x`) come first; a later `list` is a value.
  const named = (set: Set<string>) =>
    rest.some((a) => a.startsWith("-") && set.has(a)) || set.has(positional[0] ?? "");
  if (named(CONFIG_WRITES)) return true;
  if (named(CONFIG_READS)) return false;
  return positional.length !== 1;
}

/** Git config keys that name a hook folder, external command, filter, helper or included config. */
const GIT_EXEC_KEY =
  /^(?:core\.(?:hookspath|pager|editor|sshcommand|fsmonitor|gitproxy|askpass|alternaterefscommand)|sequence\.editor|diff\.external|pager\.[\w-]+|filter\.[\w.-]+|(?:merge|diff)tool\.[\w.-]+\.cmd|diff\.[\w.-]+\.(?:command|textconv)|merge\.[\w.-]+\.driver|credential\.(?:[^.]*\.)?helper|gpg\.(?:\w+\.)?program|uploadpack\.packobjectshook|init\.templatedir|include\.path|includeif\.[^.]+\.path|remote\.[^.]+\.(?:uploadpack|receivepack))$/i;

/** Repo-local git config keys that only hold harmless identity or formatting settings. */
const HARMLESS_CONFIG_KEYS = new Set([
  "user.name",
  "user.email",
  "core.quotepath",
  "core.autocrlf",
  "core.filemode",
  "core.ignorecase",
  "commit.gpgsign",
  "tag.gpgsign",
  "pull.rebase",
  "push.autosetupremote",
  "push.default",
  "init.defaultbranch",
  "color.ui",
]);

/** `git config` subcommands that precede a key name (`git config set user.name x`). */
const CONFIG_KEY_SUBS = new Set(["set", "unset"]);

/** True when a repo-local git config key is on the harmless allow-list. */
function isHarmlessConfigKey(key: string): boolean {
  return (
    HARMLESS_CONFIG_KEYS.has(key) ||
    /^advice\.[\w-]+$/.test(key) ||
    /^branch\.[^.]+\.(?:remote|merge)$/.test(key)
  );
}

/** True when `-c key=value` only disables a pager, editor, fsmonitor or credential helper. */
function isSafeExecOverride(key: string, value: string): boolean {
  const trimmed = value.trim();
  if (key === "core.pager" || key.startsWith("pager.")) return /^(?:|cat|false)$/i.test(trimmed);
  if (key === "core.editor" || key === "sequence.editor") {
    return /^(?:|true|false|:)$/i.test(trimmed);
  }
  if (key === "core.fsmonitor") return /^(?:|false|0)$/i.test(trimmed);
  if (key === "credential.helper" || /^credential\.[^.]*\.helper$/.test(key)) {
    return trimmed === "";
  }
  return false;
}

/**
 * Verdict for a `git -c key=value` or `--config-env=key=ENV` override when the key can run
 * hooks or commands. `fromEnv`: value comes from an environment variable so it isn't known here.
 */
function classifyConfigOverride(setting: string, fromEnv: boolean): RiskAssessment | undefined {
  const eq = setting.indexOf("=");
  const key = (eq >= 0 ? setting.slice(0, eq) : setting).trim().toLowerCase();
  const value = eq >= 0 ? setting.slice(eq + 1) : "";
  if (!key) return undefined;
  if (key.startsWith("alias.")) {
    if (fromEnv || value.trimStart().startsWith("!")) {
      return {
        risky: true,
        action: "other",
        reason: `Overrides git ${key}, which runs a shell command`,
        always: true,
      };
    }
    return undefined;
  }
  if (!GIT_EXEC_KEY.test(key)) return undefined;
  if (!fromEnv && isSafeExecOverride(key, value)) return undefined;
  return {
    risky: true,
    action: "other",
    reason: `Overrides git's ${key} setting, which can run external hooks or commands`,
    always: true,
  };
}

/** Verdict for a repo-local `git config` write. Harmless identity/formatting keys stay free. */
function classifyLocalConfig(raw: string[], rest: string[]): RiskAssessment {
  const rawPositional = raw.filter(
    (a, i) => !a.startsWith("-") && !CONFIG_VALUED.has(rest[i - 1] ?? ""),
  );
  const positional = rawPositional.map((a) => a.toLowerCase());
  const editsFile =
    rest.some(
      (a) => a === "-e" || a === "--edit" || a === "--rename-section" || a === "--remove-section",
    ) ||
    positional[0] === "edit" ||
    positional[0] === "rename-section" ||
    positional[0] === "remove-section";
  if (editsFile) {
    return {
      risky: true,
      action: "file_change",
      reason: "Edits repository git configuration (.git/config)",
      always: true,
    };
  }
  const keyIndex = CONFIG_KEY_SUBS.has(positional[0] ?? "") ? 1 : 0;
  const key = positional[keyIndex] ?? "";
  const value = rawPositional[keyIndex + 1] ?? "";
  if (isHarmlessConfigKey(key)) return SAFE;
  if (GIT_EXEC_KEY.test(key) || (key.startsWith("alias.") && value.trimStart().startsWith("!"))) {
    return {
      risky: true,
      action: "file_change",
      reason: `Changes git's ${key} setting in .git/config, which can run external hooks or commands`,
      always: true,
    };
  }
  return risky("file_change", `Changes repository git configuration (${key || "config"})`);
}

/** True when `target` is `.git/config`, `.git/hooks/**` (or `.git/hooks`), or worktree config. */
function isGitProtectedPath(target: string, ctx: PathContext): boolean {
  const parts = resolveAgainst(target, ctx)
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  const dot = parts.lastIndexOf(".git");
  if (dot === -1) return false;
  const inside = parts.slice(dot + 1);
  if (inside[0] === "hooks") return true;
  if (inside.length === 1 && (inside[0] === "config" || inside[0] === "config.worktree")) {
    return true;
  }
  return inside[0] === "worktrees" && inside.at(-1) === "config.worktree";
}

function gitProtectedRisk(target: string): RiskAssessment {
  return {
    risky: true,
    action: "file_change",
    reason: `Changes git's config or hooks (${target}): they run automatically on later git commands`,
    always: true,
  };
}

/** The verdict on writing `target` when it is `.git/config` or under `.git/hooks/`, else undefined. */
export function gitProtectedWrite(target: string, ctx: PathContext): RiskAssessment | undefined {
  return isGitProtectedPath(target, ctx) ? gitProtectedRisk(target) : undefined;
}

/** `.git/config` or `.git/hooks` named in inline interpreter code. */
const GIT_PROTECTED_MENTION = /\.git[\\/]+(?:config(?:\.worktree)?(?![\w.-])|hooks(?![\w.-]))/i;

/**
 * One simple command's write to `.git/config` or `.git/hooks/**`: a redirect, inline code that
 * names one, or an argument to a writing command (`cp`, `mv`, `sed -i`, `tee`, `Set-Content`, ...).
 */
export function gitProtectedCommand(
  cmd: SimpleCommand,
  ctx: PathContext,
): RiskAssessment | undefined {
  return commandWrite(cmd, {
    write: (path) => gitProtectedWrite(path, ctx),
    mention: (code) => {
      const named = GIT_PROTECTED_MENTION.exec(code);
      return named ? gitProtectedRisk(named[0]) : undefined;
    },
  });
}
