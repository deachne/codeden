import type { ParkedIdea } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ExternalLink, Lightbulb } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/lib/api";
import { factoryKeys, useParkedIdeas } from "@/lib/factory";
import { useProject } from "@/lib/queries";
import { PageHeader } from "./page-header";

/**
 * Parked ideas: good ideas the scout set aside this round, one short card each in plain words.
 * Build it files the idea as normal factory work; Not now hides it (it is never deleted).
 */
export function ParkedIdeasPage({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const { data, isPending } = useParkedIdeas(projectId);
  return (
    <>
      <PageHeader
        icon={<Lightbulb />}
        title={`${project?.name ?? "Project"} parked ideas`}
        meta="Good ideas the scout set aside"
        actions={
          <Button size="sm" variant="ghost" asChild>
            <Link to="/projects/$projectId" params={{ projectId }}>
              <ChevronLeft /> Project
            </Link>
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-3 p-6" data-testid="parked-ideas">
          {isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : data && data.length > 0 ? (
            data.map((idea) => <IdeaCard key={idea.id} projectId={projectId} idea={idea} />)
          ) : (
            <p className="py-10 text-center text-[13px] text-muted-foreground">
              No parked ideas right now. When the scout sets a good idea aside, it shows up here.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function IdeaCard({ projectId, idea }: { projectId: string; idea: ParkedIdea }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: factoryKeys.parkedIdeas(projectId) });
    void queryClient.invalidateQueries({ queryKey: factoryKeys.status(projectId) });
  };
  const build = useMutation({
    mutationFn: () => client.factory.buildParkedIdea(projectId, idea.id),
    onSuccess: () => {
      refresh();
      toast.success("Filed for the factory", { description: idea.title });
    },
    onError: (e) => toast.error("Couldn't build it", { description: e.message }),
  });
  const notNow = useMutation({
    mutationFn: () => client.factory.setParkedIdeaAside(projectId, idea.id),
    onSuccess: refresh,
    onError: (e) => toast.error("Couldn't set it aside", { description: e.message }),
  });
  const busy = build.isPending || notNow.isPending;
  return (
    <div
      className="space-y-2 rounded-lg border border-border bg-surface p-4"
      data-testid="parked-idea"
    >
      <h3 className="text-[14px] font-medium leading-snug">{idea.title}</h3>
      <p className="text-[13px] leading-snug">
        <span className="font-medium">Why the scout liked it: </span>
        {idea.whyLiked}
      </p>
      <p className="text-[13px] leading-snug text-muted-foreground">
        <span className="font-medium">Why it&apos;s parked: </span>
        {idea.whyParked}
      </p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" onClick={() => build.mutate()} disabled={busy}>
          Build it
        </Button>
        <Button size="sm" variant="outline" onClick={() => notNow.mutate()} disabled={busy}>
          Not now
        </Button>
        {idea.ideasIssue && (
          <a
            href={idea.ideasIssue.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-3xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Open in Ideas <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </div>
      {idea.details && (
        <details className="text-2xs text-muted-foreground">
          <summary className="cursor-pointer">Details</summary>
          <p className="pt-1">{idea.details}</p>
        </details>
      )}
    </div>
  );
}
