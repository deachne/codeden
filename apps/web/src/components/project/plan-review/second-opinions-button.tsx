import type { PlanReviewOptions } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useClient } from "@/lib/api";
import { factoryKeys, usePlanReview } from "@/lib/factory";

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * "Get second opinions" (§8.5), next to Approve plan: other models read the plan on their own,
 * read-only, then the Planner settles each point in a table. Never required, never automatic:
 * the box shows who will review, a rough cost and the cost cap, and nothing starts until Go.
 */
export function SecondOpinionsButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const { data: review } = usePlanReview(projectId);
  const busy = review?.status === "reviewing" || review?.status === "settling";
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={busy}
        title="Optional: other models read the plan and say what's missing or risky. Approve plan works without it."
      >
        <Users /> Get second opinions
      </Button>
      {open && <SecondOpinionsDialog projectId={projectId} onClose={() => setOpen(false)} />}
    </>
  );
}

function SecondOpinionsDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const options = useQuery({
    queryKey: ["factory", "plan-review-options", projectId],
    queryFn: () => client.planReviews.options(projectId),
    gcTime: 0,
    retry: false,
  });
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const data = options.data;
  useEffect(() => {
    if (data && picked === null) {
      setPicked(new Set(data.candidates.filter((c) => c.defaultOn).map((c) => c.providerId)));
    }
  }, [data, picked]);
  const ticked = data ? data.candidates.filter((c) => picked?.has(c.providerId)) : [];
  const capUsd = Number(cap ?? data?.defaultCapUsd ?? 0);
  const validCap = Number.isFinite(capUsd) && capUsd > 0;
  const go = useMutation({
    mutationFn: () =>
      client.planReviews.start(projectId, {
        reviewers: ticked.map((c) => c.providerId),
        capUsd,
      }),
    onSuccess: (review) => {
      queryClient.setQueryData(factoryKeys.planReview(projectId), review);
      toast.success("Asking for second opinions", {
        description: "You'll see each reviewer's progress, then the table, on this screen.",
      });
      onClose();
    },
    onError: (e: Error) => toast.error("Couldn't start", { description: e.message }),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="second-opinions-box">
        <DialogHeader>
          <DialogTitle>Get second opinions on the plan</DialogTitle>
          <DialogDescription>
            Other AI models read the plan on their own and look for gaps, risks and wrong guesses
            about the code. They can't change anything. Then the Planner checks every point against
            the real code and gives you a table to accept or reject. Nothing starts until you press
            Go.
          </DialogDescription>
        </DialogHeader>
        {options.isError ? (
          <p className="text-xs text-destructive" role="alert">
            {(options.error as Error).message}
          </p>
        ) : !data ? (
          <p className="text-xs text-muted-foreground">Looking at who is ready…</p>
        ) : (
          <OptionsBody
            data={data}
            picked={picked ?? new Set()}
            onPick={setPicked}
            cap={cap ?? String(data.defaultCapUsd)}
            onCap={setCap}
            ticked={ticked.length}
            roughUsd={ticked.reduce((n, c) => n + c.roughUsd, 0) + data.settlerUsd}
          />
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => go.mutate()}
            disabled={!data || ticked.length === 0 || !validCap || go.isPending}
          >
            Go
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OptionsBody({
  data,
  picked,
  onPick,
  cap,
  onCap,
  ticked,
  roughUsd,
}: {
  data: PlanReviewOptions;
  picked: Set<string>;
  onPick: (next: Set<string>) => void;
  cap: string;
  onCap: (value: string) => void;
  ticked: number;
  roughUsd: number;
}) {
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (!next.delete(id)) next.add(id);
    onPick(next);
  };
  return (
    <div className="space-y-3 text-xs">
      <fieldset className="space-y-1.5">
        <legend className="mb-1 font-medium text-foreground">Who reviews</legend>
        {data.candidates.length === 0 && (
          <p className="text-muted-foreground">No installed model can review read-only here yet.</p>
        )}
        {data.candidates.map((c) => (
          <label
            key={c.providerId}
            className={`flex items-start gap-2 ${c.ready ? "" : "opacity-60"}`}
          >
            <input
              type="checkbox"
              className="mt-0.5"
              checked={picked.has(c.providerId)}
              disabled={!c.ready}
              onChange={() => toggle(c.providerId)}
            />
            <span>
              <span className="font-medium text-foreground">{c.displayName}</span>
              {c.maker && <span className="text-muted-foreground"> ({c.maker})</span>}
              {!c.ready && <span className="text-muted-foreground"> · not ready: {c.reason}</span>}
              {c.ready && !c.differentMaker && (
                <span className="text-muted-foreground"> · same company as the Planner</span>
              )}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex items-center gap-2">
        <label htmlFor="plan-review-cap" className="font-medium text-foreground">
          Most each reviewer may spend
        </label>
        <span className="text-muted-foreground">$</span>
        <Input
          id="plan-review-cap"
          inputMode="decimal"
          className="h-7 w-20"
          value={cap}
          onChange={(e) => onCap(e.target.value)}
        />
      </div>
      <p className="text-muted-foreground" data-testid="second-opinions-cost">
        Rough cost: about {usd(roughUsd)} in all ({ticked} {ticked === 1 ? "reviewer" : "reviewers"}{" "}
        and the Planner settling the table). A reviewer that goes over its limit is stopped, and the
        Planner works with what came back.
      </p>
    </div>
  );
}
