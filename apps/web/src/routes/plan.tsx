import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, FileWarning, ListChecks } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SaveDiffDialog } from "@/components/editor/save-diff-dialog";
import { CodeEditor } from "@/components/on-demand";
import { PlanWithMeButton } from "@/components/project/plan-with-me-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/lib/api";
import { factoryKeys, usePlan } from "@/lib/factory";
import { useProject } from "@/lib/queries";
import { PageHeader } from "./page-header";

/**
 * Plan editor (§8.5): `.codeden/PLAN.md`, beside the vision. What gets built first and how; the
 * briefs of builders, reviewers, the scout and the sessions a PM starts carry it.
 */
export function PlanPage({ projectId }: { projectId: string }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const project = useProject(projectId);
  const { data } = usePlan(projectId);
  const [draft, setDraft] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  // CodeMirror keeps LF line endings; compare and edit the file in that form.
  const saved = data?.contents.replace(/\r\n/g, "\n");
  useEffect(() => setDraft(saved ?? null), [saved]);
  const save = useMutation({
    mutationFn: () => client.factory.savePlan(projectId, draft ?? ""),
    onSuccess: (res) => {
      setReview(false);
      queryClient.setQueryData(factoryKeys.plan(projectId), res);
      if (res.shareError) {
        toast.warning("Plan saved on this computer", {
          description: `It couldn't be committed to GitHub: ${res.shareError}`,
        });
      } else {
        toast.success("Plan saved", {
          description: res.pr ? `${res.path}, shared through PR #${res.pr.number}` : res.path,
        });
      }
    },
    onError: (e) => toast.error("Couldn't save the plan", { description: e.message }),
  });
  const exists = data?.exists ?? false;
  const dirty = draft !== null && (draft !== saved || !exists);

  return (
    <>
      <PageHeader
        icon={<ListChecks />}
        title={`${project?.name ?? "Project"} plan`}
        meta={<code className="font-mono">{data?.path ?? ".codeden/PLAN.md"}</code>}
        actions={
          <>
            <Button size="sm" variant="ghost" asChild>
              <Link to="/projects/$projectId" params={{ projectId }}>
                <ChevronLeft /> Project
              </Link>
            </Button>
            <PlanWithMeButton projectId={projectId} variant="outline" />
            <Button size="sm" disabled={!dirty} onClick={() => setReview(true)}>
              {exists ? "Review & save" : "Create plan file"}
            </Button>
          </>
        }
      />
      {data && !exists && (
        <div className="flex items-center gap-2 border-b border-status-waiting/25 bg-status-waiting/[0.06] px-5 py-2 text-2xs">
          <FileWarning className="size-3.5 text-status-waiting" />
          No plan file yet. This is the template; edit it and save to create {data.path}.
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 border-r border-border" data-testid="plan-editor">
          {draft === null ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-40" />
            </div>
          ) : (
            <CodeEditor
              docKey={`plan-${projectId}-${exists}`}
              value={draft}
              onChange={setDraft}
              onSave={() => dirty && setReview(true)}
            />
          )}
        </div>
        <aside className="hidden w-80 shrink-0 space-y-3 overflow-y-auto p-5 text-[13px] text-muted-foreground scroll-thin lg:block">
          <p>
            The vision says why the project exists. The plan says what gets built first and how: the
            first version, the technical route and what waits. How you'll check it works goes in
            Owner checks on the project page, which agents never see.
          </p>
          <p>
            Not sure what to write? Plan with me starts the Planner: it reads what the project
            already has, asks you one question at a time, and writes the vision and the plan for you
            to check.
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
        </aside>
      </div>
      <SaveDiffDialog
        open={review}
        onOpenChange={setReview}
        path={data?.path ?? "PLAN.md"}
        before={exists ? (data?.contents ?? "") : ""}
        after={draft ?? ""}
        onConfirm={() => save.mutate()}
        saving={save.isPending}
      />
    </>
  );
}
