import type { InboxItem } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Lightbulb } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";

/**
 * "New ideas parked by the scout": a green-outlined nudge with a short bullet list. Nothing waits
 * on it. Open parked ideas goes to the list and closes the card; Dismiss only closes the card, the
 * ideas stay in the list.
 */
export function ParkedIdeasCard({ item }: { item: InboxItem }) {
  const client = useClient();
  const navigate = useNavigate();
  const open = item.status === "open";
  const projectId = item.projectId;
  const bullets = (item.body ?? "")
    .split("\n")
    .map((l) => l.replace(/^- /, "").trim())
    .filter(Boolean);
  const close = useMutation({
    mutationFn: () => client.resolveInbox(item.id, { status: "dismissed" }),
    onError: (e: Error) => toast.error("Couldn't close the card", { description: e.message }),
  });
  return (
    <div
      className="rounded-xl border-2 border-status-done bg-card px-4 py-3"
      data-testid="parked-ideas-card"
    >
      <h3 className="flex items-center gap-2 text-[14px] font-medium">
        <Lightbulb className="size-4 text-status-done" /> {item.title}
      </h3>
      {bullets.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[13px] text-muted-foreground">
          {bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {open && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {projectId && (
            <Button
              size="sm"
              onClick={() => {
                close.mutate();
                void navigate({ to: "/projects/$projectId/parked-ideas", params: { projectId } });
              }}
            >
              Open parked ideas
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => close.mutate()}
            disabled={close.isPending}
          >
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
