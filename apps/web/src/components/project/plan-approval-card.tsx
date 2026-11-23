import type { Project, Snapshot } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bot, CheckCircle2, FileText, Lightbulb } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { snapshotKey } from "@/lib/queries";

/**
 * Plan approval (§8.5): while a project's plan isn't approved, CodeDen starts no agent session a
 * PM, the orchestrator, an automation or the factory asks for. This card says so on the project's
 * Overview and holds the one control that lifts it, Approve plan, which only a person can press.
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
        description: "The PM can start building, and the factory modes can be switched on.",
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
            Agents don't build here until you approve the plan: the PM, automations and the factory
            can't start work, and sessions you start yourself still run. Talk it through with the
            PM, read the vision, then approve.
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 pl-7">
        <Button size="sm" onClick={() => approve.mutate()} disabled={approve.isPending}>
          <CheckCircle2 /> Approve plan
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link to="/projects/$projectId/vision" params={{ projectId: project.id }}>
            <FileText /> Read the vision
          </Link>
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link to="/projects/$projectId/pm" params={{ projectId: project.id }}>
            <Bot /> Talk to the PM
          </Link>
        </Button>
      </div>
    </section>
  );
}
