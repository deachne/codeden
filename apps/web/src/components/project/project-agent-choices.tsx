import type { Project, ProjectAgentChoice } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PickerFooterChoice } from "@/components/composer/model-picker/footer";
import type { ModelChoice } from "@/components/composer/model-picker/logic";
import { ModelPicker } from "@/components/composer/model-picker/model-picker";
import { SettingRow, SettingsSection } from "@/components/settings/settings-ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useProjectActions } from "@/lib/project-actions";
import { useSnapshotData } from "@/lib/queries";

const toChoice = (next: ModelChoice): ProjectAgentChoice => ({
  provider: next.provider,
  model: next.model,
  effort: next.effort,
});

const same = (a: ProjectAgentChoice | null, b: ProjectAgentChoice | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Project page > Settings > Models (#178): the tool and model for this project's project manager
 * and for its workers (the agent sessions the PM, the factory and automations start here). Left
 * on "Follow shared setting", a role uses Settings → Providers. A choice that can't run later
 * (the model was removed, the tool signed out) falls back to the shared setting, and the Inbox
 * says so. Workers already running keep their model; changing the PM's retires its conversation
 * (the next message starts a fresh one), so that change asks first.
 */
export function ProjectAgentChoices({ project }: { project: Project }) {
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const { setAgentChoice } = useProjectActions();
  const [pendingPm, setPendingPm] = useState<{ choice: ProjectAgentChoice | null } | null>(null);
  const toSettings = (
    <Link
      to="/settings/$section"
      params={{ section: "providers" }}
      className="underline underline-offset-2 hover:text-foreground"
    >
      Settings → Providers
    </Link>
  );

  function row(
    choice: ProjectAgentChoice | null,
    pick: (next: ProjectAgentChoice | null) => void,
    testId: string,
  ) {
    return (
      <div className="rounded-lg border border-border px-1 py-0.5" data-testid={testId}>
        <ModelPicker
          providers={providers}
          projectId={project.id}
          align="end"
          placeholder="Follow shared setting"
          value={choice}
          onChange={(next) => pick(toChoice(next))}
          footer={(close) => (
            <PickerFooterChoice
              active={choice === null}
              onClick={() => {
                pick(null);
                close();
              }}
            >
              Follow shared setting: {toSettings}
            </PickerFooterChoice>
          )}
        />
      </div>
    );
  }

  const choosePm = (next: ProjectAgentChoice | null) => {
    if (!same(next, project.pmChoice)) setPendingPm({ choice: next });
  };
  const chooseWorkers = (next: ProjectAgentChoice | null) => {
    if (!same(next, project.workerChoice)) void setAgentChoice(project, "workerChoice", next);
  };

  return (
    <>
      <SettingsSection
        title="Models for this project"
        description="Pick a tool and model for this project's project manager and for its workers. Left on the shared setting, a project uses Settings → Providers, as before. A model chosen when something is started still wins."
      >
        <SettingRow
          label="Project manager"
          help={
            <>
              The agent that plans and steers this project.{" "}
              {project.pmChoice ? "Used instead of" : "Not set: uses"} {toSettings}. Changing it
              starts a fresh conversation with the project manager.
            </>
          }
        >
          {row(project.pmChoice, choosePm, "project-pm-choice")}
        </SettingRow>
        <SettingRow
          label="Workers"
          help={
            <>
              The agent sessions started here that don't pick their own model.{" "}
              {project.workerChoice ? "Used instead of" : "Not set: uses"} {toSettings}. Sessions
              already running keep their model.
            </>
          }
        >
          {row(project.workerChoice, chooseWorkers, "project-worker-choice")}
        </SettingRow>
        <p className="px-4 py-3 text-2xs leading-relaxed text-muted-foreground">
          If a choice can't be used later (the model was removed, or the tool is signed out), the
          shared setting is used instead and the Inbox tells you. Some models reached through
          another tool (for example DeepSeek through Cursor) run under that tool's own rules; this
          is not an uncensored model.
        </p>
      </SettingsSection>
      <AlertDialog open={pendingPm !== null} onOpenChange={(open) => !open && setPendingPm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change the project manager's model?</AlertDialogTitle>
            <AlertDialogDescription>
              Changing the project manager's model starts a fresh conversation with it. Its current
              conversation is archived (you can still read it) once it isn't working, and messages
              waiting for it move over. Nothing else about the project changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingPm) void setAgentChoice(project, "pmChoice", pendingPm.choice);
                setPendingPm(null);
              }}
            >
              Change and start fresh
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
