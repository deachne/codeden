import { StartPreviewInput, StopPreviewInput } from "@codeden/contracts";
import { runTool } from "../../../services/exec";
import { startPreview, stopPreview } from "../../../services/preview";
import { defineTool, ToolError } from "../../define";
import { projectFor } from "../shared/helpers";

/** `start_preview`: run the project's app from a branch so the owner can open it by a link. */
export const startPreviewTool = defineTool({
  name: "start_preview",
  description:
    "Start the project's app from a branch (a branch name or a pull request number) so the owner can try it. Uses the devServer of .codeden/project.json and returns the working URL plus the link of the CodeDen session where it runs; the owner clicks the link, never types commands. A second call for the same branch reuses the running preview. Refuses with no_dev_server when the project sets none. The URL is 127.0.0.1: it works only on the computer CodeDen runs on, so say so in your reply; never open the app to the network without the owner's yes. Stop it with stop_preview when the owner is done.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: StartPreviewInput,
  handler: async (input, { services, projectId, sessionId }) => {
    const project = projectFor(services, projectId);
    try {
      return await startPreview(
        {
          exec: runTool,
          sessions: services.sessions,
          sessionRepo: services.sessionRepo,
          prBranch: async (id, n) => (await services.github.getPrStatus(id, n)).headBranch,
        },
        project,
        input,
        { sessionId },
      );
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error));
    }
  },
});

/** `stop_preview`: stop a branch's preview. */
export const stopPreviewTool = defineTool({
  name: "stop_preview",
  description: "Stop the preview of a branch started with start_preview.",
  roles: ["pm"],
  scope: "project",
  alwaysLoad: true,
  input: StopPreviewInput,
  handler: async (input, { services, projectId }) =>
    stopPreview(
      {
        exec: runTool,
        sessions: services.sessions,
        sessionRepo: services.sessionRepo,
        prBranch: async (id, n) => (await services.github.getPrStatus(id, n)).headBranch,
      },
      projectFor(services, projectId),
      input,
    ),
});
