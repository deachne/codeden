import {
  type DevServerConfig,
  type Project,
  previewWorkKey,
  type Session,
  type StartPreviewResult,
  type StartSessionRequest,
  type StartSessionResponse,
  type StopPreviewResult,
} from "@codeden/contracts";
import type { Exec } from "./exec";
import { projectDevServerAtHead } from "./factory/owner-checks";

/**
 * App previews for the owner (the PM's `start_preview` and `stop_preview`): the project's app
 * started from a branch's code in a preview session, so a review hand-off is a link that works.
 * The session runs the `devServer` of `.codeden/project.json` (the path owner checks use) and
 * opens it in the session browser; it stays up until the PM or the owner stops it.
 */

/** The parts of the services a preview needs. */
export interface PreviewDeps {
  exec: Exec;
  sessions: {
    start(req: StartSessionRequest): Promise<StartSessionResponse>;
    stop(sessionId: string): Promise<Pick<Session, "status">>;
  };
  sessionRepo: { list(query: { projectId: string; workKey: string }): Session[] };
}

const ENDED = new Set(["completed", "failed", "stopped"]);

/** The branch's running preview session, if any. */
function running(deps: PreviewDeps, project: Project, branch: string): Session | undefined {
  return deps.sessionRepo
    .list({ projectId: project.id, workKey: previewWorkKey(branch) })
    .find((s) => !ENDED.has(s.status));
}

/** The brief of the preview session: start the app, open it, keep it up, change nothing. */
export function previewPrompt(branch: string, dev: DevServerConfig): string {
  const where = dev.cwd ? ` in \`${dev.cwd}\`` : "";
  const port = dev.port ? ` It listens on port ${dev.port}.` : "";
  return [
    `**Preview**: run the project's app from the branch \`${branch}\` so its owner can try it. Don't change any file and don't judge the code.`,
    `Start the app with \`${dev.command}\`${where} (the \`devServer\` of \`.codeden/project.json\`).${port} Install the dependencies first if they are missing, non-interactively. Run the server in the background so your shell stays free, and wait until the port answers.`,
    "Then open it with `browser_open_dev_server` so the owner can also see it in this session's browser panel, and reply in one plain sentence that the app is running and at which address. If it doesn't start, say in one plain sentence what went wrong.",
    "Then stay idle. Leave the server running; stop it (and say so) only when you are told to, or when nobody has written to you for an hour.",
  ].join("\n");
}

/** Start the app from `branch`, or reuse the branch's preview. Refuses without a `devServer`. */
export async function startPreview(
  deps: PreviewDeps,
  project: Project,
  branch: string,
  by: { sessionId?: string | null } = {},
): Promise<StartPreviewResult> {
  const dev = await projectDevServerAtHead(project, {
    exec: deps.exec,
    head: project.kind === "github" ? `origin/${branch}` : branch,
  });
  if (!dev) {
    return {
      status: "no_dev_server",
      message:
        "Set a devServer in .codeden/project.json so the app can be started. Tell the owner in one line that you are setting that up first, start a short builder session to find the right command and port and add devServer through a normal pull request, and try again after it merges.",
    };
  }
  const url = dev.port ? `http://127.0.0.1:${dev.port}` : null;
  const reached = (status: "started" | "reused", sessionId: string): StartPreviewResult => ({
    status,
    url,
    reachableFrom: "this-computer",
    sessionId,
    sessionLink: `/sessions/${sessionId}`,
    message: `${status === "reused" ? "The branch already has a preview running. " : ""}${
      url
        ? `${url} works only on the computer CodeDen runs on, not from a phone.`
        : "The devServer sets no port, so the address is what the preview session reports."
    } The session link works wherever CodeDen does.`,
  });
  const existing = running(deps, project, branch);
  if (existing) return reached("reused", existing.id);
  const res = await deps.sessions.start({
    projectId: project.id,
    role: "agent",
    purpose: `Preview: ${branch}`.slice(0, 300),
    workKey: previewWorkKey(branch),
    title: `Preview: ${branch}`.slice(0, 200),
    startedBy: { kind: "pm", id: by.sessionId ?? undefined },
    parentSessionId: by.sessionId ?? undefined,
    workspace: {
      mode: "worktree",
      baseRef: project.kind === "github" ? `origin/${branch}` : branch,
      ...(project.kind === "github" ? { fetch: true } : {}),
    },
    input: { text: previewPrompt(branch, dev), from: "pm" },
    conflict: { resolution: "wait" },
  } as StartSessionRequest);
  if (res.status === "started" || res.status === "queued") return reached("started", res.sessionId);
  const other =
    res.status === "joined" ? res.sessionId : (running(deps, project, branch)?.id ?? "");
  if (other) return reached("reused", other);
  throw new Error(`The preview didn't start (${res.status})`);
}

/** Stop the branch's preview session. */
export async function stopPreview(
  deps: PreviewDeps,
  project: Project,
  branch: string,
): Promise<StopPreviewResult> {
  const session = running(deps, project, branch);
  if (!session) return { status: "none", message: `No preview is running for ${branch}.` };
  await deps.sessions.stop(session.id);
  return { status: "stopped", message: `The preview for ${branch} was stopped.` };
}
