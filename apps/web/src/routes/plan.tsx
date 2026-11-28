import { Link } from "@tanstack/react-router";
import { ChevronLeft, ListChecks, Map as MapIcon } from "lucide-react";
import { DocEditorPage } from "@/components/project/doc-editor-page";
import { PlanWithMeButton } from "@/components/project/plan-with-me-button";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { factoryKeys, usePlan } from "@/lib/factory";
import { useProject } from "@/lib/queries";

/**
 * Plan editor (§8.5): `.codeden/PLAN.md`, beside the vision. What gets built first and how; the
 * briefs of builders, reviewers, the scout and the sessions a PM starts carry it.
 */
export function PlanPage({ projectId }: { projectId: string }) {
  const client = useClient();
  const project = useProject(projectId);
  const { data } = usePlan(projectId);

  return (
    <DocEditorPage
      docKey={`plan-${projectId}`}
      noun="plan"
      icon={<ListChecks />}
      title={`${project?.name ?? "Project"} plan`}
      defaultPath=".codeden/PLAN.md"
      data={data}
      queryKey={factoryKeys.plan(projectId)}
      save={(contents) => client.factory.savePlan(projectId, contents)}
      testId="plan-editor"
      actions={
        <>
          <Button size="sm" variant="ghost" asChild>
            <Link to="/projects/$projectId" params={{ projectId }}>
              <ChevronLeft /> Project
            </Link>
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <Link to="/projects/$projectId/feature-map" params={{ projectId }}>
              <MapIcon /> Feature map
            </Link>
          </Button>
          <PlanWithMeButton projectId={projectId} variant="outline" />
        </>
      }
      aside={
        <>
          <p>
            The vision says why the project exists. The plan says what gets built first and how: the
            first version, the technical route and what waits. How you'll check it works goes in
            Owner checks on the project page, which agents never see.
          </p>
          <p>
            Not sure what to write? Plan with me starts the Planner: it reads what the project
            already has, asks you one question at a time, and writes the vision, the plan and the
            feature map for you to check.
          </p>
          <p>
            Agents get it in their brief, so keep it short. Progress isn't tracked here: that lives
            in GitHub issues.
          </p>
          <p>
            Like everything in <code className="font-mono">.codeden/</code>, the plan is protected:
            an agent's change to it never merges by itself.
          </p>
          <Link
            to="/projects/$projectId/vision"
            params={{ projectId }}
            className="inline-block text-foreground underline-offset-2 hover:underline"
          >
            Open the vision →
          </Link>
        </>
      }
    />
  );
}
