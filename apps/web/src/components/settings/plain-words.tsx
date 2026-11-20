import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useProjectActions } from "@/lib/project-actions";
import { useSnapshot } from "@/lib/queries";
import { SettingRow, SettingsSection } from "./settings-ui";

/**
 * Settings > General: per project, "Explain changes in plain words" (`Project.plainWords`, §10.1).
 * Off by default. Only GitHub projects have pull requests, so only they are listed.
 */
export function PlainWordsSettings() {
  // Undefined until the snapshot loads, so "Add a project" never shows before it has (#400).
  const projects = useSnapshot().data?.projects?.filter((p) => p.kind === "github");
  const { setPlainWords } = useProjectActions();
  return (
    <SettingsSection
      title="Explain changes in plain words"
      description="Agents start every pull request with a short note in everyday words: what changed for you, how to try it, what wasn't checked and how to undo it. CodeDen shows that note first on the factory's items and in the inbox. A missing note is only flagged, it never holds up a merge. Applies to pull requests opened after the change."
    >
      {projects === undefined ? (
        <div className="px-4 py-3.5" role="status" aria-label="Loading projects">
          <Skeleton className="h-4 w-1/3" />
        </div>
      ) : projects.length === 0 ? (
        <p className="px-4 py-3.5 text-2xs text-muted-foreground">
          Add a GitHub project to choose this per project.
        </p>
      ) : (
        projects.map((project) => (
          <SettingRow
            key={project.id}
            label={project.name}
            help={
              project.plainWords
                ? "Pull requests start with a plain-words note."
                : "Pull requests are written for developers."
            }
          >
            <Switch
              aria-label={`Explain ${project.name}'s changes in plain words`}
              checked={project.plainWords}
              onCheckedChange={(on) => void setPlainWords(project, on)}
            />
          </SettingRow>
        ))
      )}
    </SettingsSection>
  );
}
