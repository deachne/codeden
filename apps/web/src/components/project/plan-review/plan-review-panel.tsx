import type { PlanReview, PlanReviewRow } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { factoryKeys, usePlanReview } from "@/lib/factory";

const REVIEWER_WORDS = {
  running: "reading the plan…",
  done: "done",
  stopped_cap: "stopped: it went over its limit",
  failed: "didn't finish",
} as const;

/**
 * The second opinions on a plan (§8.5), on the plan screen: who is reviewing and how far they
 * are, then the Planner's table with Accept and Reject per row. Accepted rows go back to the
 * Planner, which folds them into the plan; the owner then presses Approve plan as usual.
 */
export function PlanReviewPanel({ projectId }: { projectId: string }) {
  const { data: review } = usePlanReview(projectId);
  if (!review || review.status === "cancelled") return null;
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4 text-xs"
      aria-label="Second opinions on the plan"
      data-testid="plan-review"
    >
      <p className="font-medium text-foreground">Second opinions on the plan</p>
      <ul className="space-y-0.5 text-muted-foreground">
        {review.reviewers.map((r) => (
          <li key={r.sessionId}>
            <span className="font-medium text-foreground">{r.displayName}</span>:{" "}
            {REVIEWER_WORDS[r.status]}
          </li>
        ))}
      </ul>
      {review.status === "reviewing" && (
        <Waiting>Waiting for the reviewers. You can leave this screen: it keeps going.</Waiting>
      )}
      {review.status === "settling" && (
        <Waiting>The Planner is checking each point against the real code…</Waiting>
      )}
      {(review.status === "ready" || review.status === "applied") && (
        <Table projectId={projectId} review={review} />
      )}
      {(review.status === "reviewing" || review.status === "settling") && (
        <CancelButton projectId={projectId} />
      )}
    </section>
  );
}

function Waiting({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-1.5 text-muted-foreground" role="status">
      <Loader2 className="size-3.5 animate-spin" aria-hidden /> {children}
    </p>
  );
}

function CancelButton({ projectId }: { projectId: string }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => client.planReviews.cancel(projectId),
    onSuccess: (next) => queryClient.setQueryData(factoryKeys.planReview(projectId), next),
    onError: (e: Error) => toast.error("Couldn't stop", { description: e.message }),
  });
  return (
    <Button size="sm" variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
      Stop asking
    </Button>
  );
}

function Table({ projectId, review }: { projectId: string; review: PlanReview }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const applied = review.status === "applied";
  const accepted = review.rows.filter((r) => r.decision === "accepted").length;
  const decide = useMutation({
    mutationFn: (v: { row: PlanReviewRow; decision: PlanReviewRow["decision"] }) =>
      client.planReviews.decide(projectId, v.row.id, v.decision),
    onSuccess: (next) => queryClient.setQueryData(factoryKeys.planReview(projectId), next),
    onError: (e: Error) => toast.error("Couldn't save your answer", { description: e.message }),
  });
  const apply = useMutation({
    mutationFn: () => client.planReviews.apply(projectId),
    onSuccess: (next) => {
      queryClient.setQueryData(factoryKeys.planReview(projectId), next);
      toast.success("Sent to the Planner", {
        description: "It adds the accepted rows to the plan. Then read the plan and approve it.",
      });
    },
    onError: (e: Error) => toast.error("Couldn't send them", { description: e.message }),
  });
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              <th className="p-2 font-medium">Point</th>
              <th className="p-2 font-medium">Raised by</th>
              <th className="p-2 font-medium">Planner's call</th>
              <th className="p-2 font-medium">Your answer</th>
            </tr>
          </thead>
          <tbody>
            {review.rows.map((row) => (
              <tr
                key={row.id}
                className={`border-t border-border align-top ${row.askOwner ? "bg-status-waiting/10" : ""}`}
              >
                <td className="p-2 text-foreground">
                  {row.askOwner && (
                    <span className="mb-1 block font-medium text-status-waiting">
                      Needs your decision: only you can settle this one
                    </span>
                  )}
                  {row.point}
                </td>
                <td className="p-2 text-muted-foreground">{row.raisedBy.join(", ")}</td>
                <td className="p-2 text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {row.stance === "agree" ? "Agrees." : "Disagrees."}
                  </span>{" "}
                  {row.call} <span className="block">{row.reason}</span>
                </td>
                <td className="p-2">
                  <fieldset className="flex gap-1" aria-label={`Answer for: ${row.point}`}>
                    {(["accepted", "rejected"] as const).map((d) => (
                      <Button
                        key={d}
                        size="sm"
                        variant={row.decision === d ? "default" : "outline"}
                        aria-pressed={row.decision === d}
                        disabled={applied || decide.isPending}
                        onClick={() =>
                          decide.mutate({ row, decision: row.decision === d ? "pending" : d })
                        }
                      >
                        {d === "accepted" ? <Check /> : <X />}
                        {d === "accepted" ? "Accept" : "Reject"}
                      </Button>
                    ))}
                  </fieldset>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {applied ? (
        <p className="text-muted-foreground">
          Sent to the Planner. When it has updated the plan, read it and press Approve plan.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => apply.mutate()}
            disabled={accepted === 0 || apply.isPending}
          >
            Add accepted to plan{accepted > 0 ? ` (${accepted})` : ""}
          </Button>
        </div>
      )}
    </div>
  );
}
