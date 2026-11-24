import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";

/**
 * "Plan with me" (§8.5): opens the project's Planner session, starting it the first time. The
 * Planner looks at what the project has, asks the owner one question at a time, then hands over
 * the vision and the plan for the owner to approve.
 */
export function PlanWithMeButton({
  projectId,
  variant = "default",
}: {
  projectId: string;
  variant?: "default" | "outline";
}) {
  const client = useClient();
  const navigate = useNavigate();
  const start = useMutation({
    mutationFn: () => client.startPlanner(projectId),
    onSuccess: (res) => {
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: res.sessionId } });
    },
    onError: (e: Error) => toast.error("Couldn't start the Planner", { description: e.message }),
  });
  return (
    <Button
      size="sm"
      variant={variant}
      onClick={() => start.mutate()}
      disabled={start.isPending}
      title="Talk it through with the Planner: it asks one question at a time, then writes the vision and the plan for you to approve"
    >
      <MessagesSquare /> Plan with me
    </Button>
  );
}
