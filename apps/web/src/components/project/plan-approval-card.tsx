import type { Project, Snapshot } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, FileText, Lightbulb, ListChecks } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { snapshotKey } from "@/lib/queries";
import { PlanReviewPanel } from "./plan-review/plan-review-panel";
import { SecondOpinionsButton } from "./plan-review/second-opinions-button";
import { PlanWithMeButton } from "./plan-with-me-button";

/**
 * Plan approval (§8.5): while a project's plan isn't approved, CodeDen starts no agent session a
 * PM, the orchestrator, an automation or the factory asks for. This card says so on the project's
 * Overview and holds the one control that lifts it, Approve plan, which only a person can press.
 * While planning, "Plan with me" (the Planner) leads; once a plan is handed over, approving does.
 */
export function PlanApprovalCard({ project }: { project: Project }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const approve = useMutation({
    mutationFn: () => client.approvePlan(project.id),
    onSuccess: (next) => {
      queryClient.setQueryData<Snapshot>(snapshotKey, (s) =>
        s ? { ...s, projects: s.projects.map((p) => (p.id === next.id ? next : p)) } : s,
      );
      toast.success("Plan approved", {
        description: "The PM picks up the first job, and the factory modes can be switched on.",
      });
    },
    onError: (e: Error) => toast.error("Couldn't approve the plan", { description: e.message }),
  });
  if ((project.planStatus ?? "approved") === "approved") return null;
  const waiting = project.planStatus === "awaiting_approval";
  return (
    <section
      className="rounded-lg border border-status-waiting/40 bg-status-waiting/5 p-4 text-xs"
      aria-label="Plan approval"
      data-testid="plan-approval"
    >
      <div className="flex items-start gap-3">
        <Lightbulb className="mt-0.5 size-4 shrink-0 text-status-waiting" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium text-foreground">
            {waiting ? "A plan is ready for you to check" : "Plan this project first"}
          </p>
          <p className="text-muted-foreground">
            {waiting
              ? "Read the vision, the plan and the owner checks below, then approve. "
              : "Press Plan with me: the Planner looks at what's here, asks you one question at a time, and writes the vision, the plan and your owner checks. Then read them and approve. "}
            Until you approve, the PM, automations and the factory can't start work here. Sessions
            you start yourself still run.
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 pl-7">
        {!waiting && <PlanWithMeButton projectId={project.id} />}
        <Button
          size="sm"
          variant={waiting ? "default" : "outline"}
          onClick={() => approve.mutate()}
          disabled={approve.isPending}
        >
          <CheckCircle2 /> Approve plan
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link to="/projects/$projectId/vision" params={{ projectId: project.id }}>
            <FileText /> Read the vision
          </Link>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link to="/projects/$projectId/plan" params={{ projectId: project.id }}>
            <ListChecks /> Read the plan
          </Link>
        </Button>
        {waiting && <SecondOpinionsButton projectId={project.id} />}
        {waiting && <PlanWithMeButton projectId={project.id} variant="outline" />}
      </div>
      {waiting && (
        <div className="mt-3 pl-7">
          <PlanReviewPanel projectId={project.id} />
        </div>
      )}
    </section>
  );
}
