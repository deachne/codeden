import type { RiskAssessment } from "./assessment";
import { risky } from "./assessment";
import { binName, unwrap } from "./command-words";
import { isInside, isInTemp, isTempRoot, type PathContext, resolveAgainst } from "./paths";
import type { SimpleCommand } from "./shell";

/**
 * Container commands (#151). A container can mount the host's filesystem (`-v /:/host`), the
 * Docker socket (`-v /var/run/docker.sock:/var/run/docker.sock`) or run privileged, all of which
 * hand it the user's whole machine: it writes anywhere, reads every credential, and with the
 * socket or `--privileged` it can become root on the host. The worktree rules would otherwise
 * never see those paths, so a container command is judged here instead:
 *
 * - a host bind mount whose source is outside the worktree, an extra root or temp → asks as a
 *   write outside the worktree (a named volume or a path only inside the container is not one);
 * - `--privileged`, `--cap-add`, `--device`, `--pid=host`, `--network=host`, `--ipc=host`,
 *   `--userns=host`, `--security-opt` that weakens the sandbox, or `-u 0`/`--user root` → asks
 *   as elevated privileges;
 * - the Docker/Podman socket or `--volumes-from` → asks, since the container then controls (or
 *   inherits) other containers and their mounts.
 *
 * `docker cp` needs no rule of its own (its paths are ordinary files, so `classifyWrite` and the
 * secrets checks see them). `docker ps`, `docker images`, `docker build -t x .` and the like run
 * freely; building from a context outside the worktree asks like any other read from there.
 */

/** The tools this rule knows, and the subcommands that start or join a container. */
const CONTAINERS: ReadonlySet<string> = new Set(["run", "create", "exec", "start"]);

const TOOLS: ReadonlySet<string> = new Set(["docker", "podman", "nerdctl"]);

/** Flags that take a value, so the word after them is not the subcommand or a path. */
export const VALUED: ReadonlySet<string> = new Set([
  "-e",
  "--env",
  "--env-file",
  "-w",
  "--workdir",
  "-p",
  "--publish",
  "--name",
  "--network",
  "--net",
  "--user",
  "-u",
  "--entrypoint",
  "--platform",
  "--pull",
  "--label",
  "-l",
  "--log-driver",
  "--log-opt",
  "--restart",
  "--hostname",
  "-h",
  "--add-host",
  "--dns",
  "--cidfile",
  "--memory",
  "-m",
  "--cpus",
  "--shm-size",
  "--ulimit",
  "--cap-add",
  "--cap-drop",
  "--device",
  "--security-opt",
  "--volumes-from",
  "--tmpfs",
  "--mount",
  "-v",
  "--volume",
  "--group-add",
  "--sysctl",
  "--gpus",
  "--ipc",
  "--pid",
  "--userns",
  "--cgroupns",
  "--pids-limit",
  "--stop-signal",
  "--user",
]);

/** The Docker socket, as a host path a mount may name. */
const SOCKETS = ["/var/run/docker.sock", "/run/docker.sock", "/var/run/podman/podman.sock"];

/** Flags whose presence alone asks: they relax the container's isolation. */
const ELEVATING = new Set([
  "--privileged",
  "--pid=host",
  "--network=host",
  "--net=host",
  "--ipc=host",
  "--userns=host",
  "--cgroupns=host",
]);

/** `--flag value` forms of the same relaxation. */
const ELEVATING_VALUED = new Set([
  "--pid",
  "--network",
  "--net",
  "--ipc",
  "--userns",
  "--cgroupns",
]);

/** Values that name the host itself (or root) rather than a sandbox or a named user. */
const hostValue = (value: string) => /^(host|root|0)$/i.test(value);

/**
 * The verdict on a container command that starts or joins a container, or undefined for anything
 * else (another command, or one that names no host path and asks for no privilege).
 */
export function containerRisk(cmd: SimpleCommand, ctx: PathContext): RiskAssessment | undefined {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  if (!TOOLS.has(bin)) return undefined;
  const rest = containerArgs(tokens.slice(1));
  if (!rest) return undefined;
  return judgeArgs(rest, ctx);
}

/** The arguments after the subcommand, or undefined when this command starts no container. */
function containerArgs(args: string[]): string[] | undefined {
  // `docker compose run …`: compose's own flags come first, then its subcommand.
  const at = args.findIndex((arg) => !arg.startsWith("-"));
  if (at === -1) return undefined;
  const sub = (args[at] as string).toLowerCase();
  if (sub === "compose" || sub === "docker-compose") {
    const inner = args.slice(at + 1);
    // Compose's own global flags take a value (`-f file`, `-p project`), then its subcommand.
    for (let i = 0; i < inner.length; i += 1) {
      const arg = inner[i] as string;
      if (arg === "-f" || arg === "--file" || arg === "-p" || arg === "--project-name") i += 1;
      else if (!arg.startsWith("-")) {
        return CONTAINERS.has(arg.toLowerCase()) ? inner.slice(i + 1) : undefined;
      }
    }
    return undefined;
  }
  return CONTAINERS.has(sub) ? args.slice(at + 1) : undefined;
}

/** Judge a container's flags: its mounts and the privileges it asks for. */
function judgeArgs(args: string[], ctx: PathContext): RiskAssessment | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!arg.startsWith("-")) continue; // the image, the command, its arguments
    const [flag, inline] = splitFlag(arg);
    const value = inline ?? (VALUED.has(flag) ? args[i + 1] : undefined);
    if (inline === undefined && VALUED.has(flag)) i += 1;

    if (flag === "--privileged") {
      return risky("other", "Runs a privileged container, which has the host's own power");
    }
    if (ELEVATING.has(arg.toLowerCase())) {
      return risky("other", `Runs a container with ${arg}, which reaches beyond its own sandbox`);
    }
    if (ELEVATING_VALUED.has(flag) && value !== undefined && hostValue(value)) {
      return risky("other", `Runs a container with ${flag} ${value}, on the host itself`);
    }
    if ((flag === "-u" || flag === "--user") && value !== undefined && hostValue(value)) {
      return risky("other", "Runs a container as root, which can write anything it mounts");
    }
    if (flag === "--cap-add" || flag === "--device" || flag === "--security-opt") {
      const shown = value ? `${arg.startsWith(flag) ? flag : arg} ${value}` : arg;
      return risky("other", `Gives the container ${shown}, beyond its own sandbox`);
    }
    if (flag === "--volumes-from") {
      return risky(
        "outside_worktree",
        "Shares another container's folders with this one, which may reach the host",
      );
    }
    if (flag === "-v" || flag === "--volume") {
      const source = volumeSource(value);
      const verdict = source && judgeHostPath(source, ctx, `Mounts ${source} from the host`);
      if (verdict) return verdict;
      continue;
    }
    if (flag === "--mount") {
      const source = mountSource(value);
      const verdict = source && judgeHostPath(source, ctx, `Mounts ${source} from the host`);
      if (verdict) return verdict;
    }
  }
  return undefined;
}

/** `--flag=value` split into the flag and its value (`--mount=type=bind,…`); else the flag alone. */
function splitFlag(arg: string): [string, string | undefined] {
  if (!arg.startsWith("-") || !arg.includes("=")) return [arg.toLowerCase(), undefined];
  const at = arg.indexOf("=");
  return [arg.slice(0, at).toLowerCase(), arg.slice(at + 1)];
}

/** An absolute path, a `~`-relative one, a home/temp variable or a `.`-relative one is a host path. */
const LOOKS_LIKE_HOST_PATH = (value: string): boolean =>
  /^([a-z]:[\\/]|[\\/~$%]|\.)/i.test(value.trim());

/**
 * The host path a `-v`/`--volume` value mounts, or undefined when it mounts a named volume or
 * only names a path inside the container (`-v /data`). `src:dst[:opts]` and `C:\x:dst` both read.
 */
function volumeSource(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Windows paths put a colon in the drive letter, so the split comes after it.
  const at = /^[a-z]:[\\/]/i.test(value) ? value.indexOf(":", 2) : value.indexOf(":");
  if (at <= 0) return undefined;
  const source = value.slice(0, at).trim();
  return LOOKS_LIKE_HOST_PATH(source) ? source : undefined;
}

/** `--mount type=bind,source=/x,target=/y` (or `src=`): the host path it binds. */
function mountSource(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parts: Record<string, string> = {};
  for (const part of value.split(",")) {
    const at = part.indexOf("=");
    if (at > 0) parts[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
  }
  const source = parts.source ?? parts.src;
  return source && LOOKS_LIKE_HOST_PATH(source) ? source : undefined;
}

/** Refuse a host mount outside the worktree, extra roots and temp; a named volume never gets here. */
function judgeHostPath(source: string, ctx: PathContext, what: string): RiskAssessment | undefined {
  const slashed = source.replace(/\\/g, "/");
  if (SOCKETS.includes(slashed)) {
    return risky(
      "outside_worktree",
      "Gives the container the Docker socket, which can control the host's containers as root",
    );
  }
  const abs = resolveAgainst(source, ctx);
  const inWorktree = [ctx.cwd, ...(ctx.extraRoots ?? [])].some((root) => isInside(abs, root, ctx));
  // Temp is already the agent's to write; mounting it (or a folder in it) adds nothing.
  if (inWorktree || isInTemp(abs, ctx) || isTempRoot(abs, ctx)) return undefined;
  return risky("outside_worktree", `${what}, outside the worktree`);
}
