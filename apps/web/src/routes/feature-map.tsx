import { Link } from "@tanstack/react-router";
import { ChevronLeft, Map as MapIcon } from "lucide-react";
import { DocEditorPage } from "@/components/project/doc-editor-page";
import { PlanWithMeButton } from "@/components/project/plan-with-me-button";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { factoryKeys, useFeatureMap } from "@/lib/factory";
import { useProject } from "@/lib/queries";

/**
 * Feature map editor (§8.5): `.codeden/FEATURE_MAP.md`, beside the vision and the plan. Every
 * screen and button a person can reach, in the owner's words, so people and agents name the same
 * places. The Planner writes it with the owner; briefs carry it.
 */
export function FeatureMapPage({ projectId }: { projectId: string }) {
  const client = useClient();
  const project = useProject(projectId);
  const { data } = useFeatureMap(projectId);

  return (
    <DocEditorPage
      docKey={`feature-map-${projectId}`}
      noun="feature map"
      icon={<MapIcon />}
      title={`${project?.name ?? "Project"} feature map`}
      defaultPath=".codeden/FEATURE_MAP.md"
      data={data}
      queryKey={factoryKeys.featureMap(projectId)}
      save={(contents) => client.factory.saveFeatureMap(projectId, contents)}
      testId="feature-map-editor"
      actions={
        <>
          <Button size="sm" variant="ghost" asChild>
            <Link to="/projects/$projectId/plan" params={{ projectId }}>
              <ChevronLeft /> Plan
            </Link>
          </Button>
          <PlanWithMeButton projectId={projectId} variant="outline" />
        </>
      }
      aside={
        <>
          <p>
            A plain list of every screen and button a person can reach, in the words you use for
            them: "the Export button on the project page", not "the thing on the left". Agents and
            owner checks use the same names.
          </p>
          <p>
            One heading per screen, one line per button or action. Add "(planned)" to anything that
            isn't built yet.
          </p>
          <p>
            Plan with me drafts it with you. For a project that already exists, the Planner reads
            what's there and checks each screen with you, one question at a time.
          </p>
          <p>
            Agents get it in their brief, so keep it short. Like everything in{" "}
            <code className="font-mono">.codeden/</code>, it is protected: an agent's change to it
            never merges by itself.
          </p>
        </>
      }
    />
  );
}
