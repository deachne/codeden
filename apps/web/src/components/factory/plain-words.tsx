import { PLAIN_WORDS_HEADING } from "@codeden/contracts";
import { useQuery } from "@tanstack/react-query";
import { MessageSquareText } from "lucide-react";
import { Markdown } from "@/components/thread/markdown";
import { useClient } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * "Explain changes in plain words" (`Project.plainWords`, §10.1): the `## In plain words` section
 * of a pull request's description, shown first, above the technical detail. Nothing is shown when
 * the description has none, so with the setting off every view looks as it did.
 */
export function PlainWordsCard({ text, className }: { text: string; className?: string }) {
  return (
    <section
      className={cn("rounded-xl border border-primary/25 bg-primary/[0.04] px-4 py-3", className)}
      data-testid="plain-words"
      aria-label={PLAIN_WORDS_HEADING}
    >
      <h3 className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold tracking-wider text-primary uppercase">
        <MessageSquareText className="size-3.5" />
        {PLAIN_WORDS_HEADING}
      </h3>
      <div className="text-[13px] leading-relaxed">
        <Markdown>{text}</Markdown>
      </div>
    </section>
  );
}

/**
 * The section of a factory item's PR, from the synced pull requests (no call to GitHub). One
 * query of the project's PRs serves every item, the page and the Factory view's sheet alike.
 */
export function PrPlainWords({
  projectId,
  prNumber,
  className,
}: {
  projectId: string;
  prNumber: number | null | undefined;
  className?: string;
}) {
  const client = useClient();
  const { data } = useQuery({
    queryKey: ["github", "prs", projectId, "all"],
    queryFn: () => client.github.prs(projectId, "all"),
    enabled: Boolean(prNumber),
    staleTime: 30_000,
  });
  const text = data?.prs.find((p) => p.number === prNumber)?.plainWords;
  return text ? <PlainWordsCard text={text} className={className} /> : null;
}

/**
 * The section of an inbox item's PR, from the synced pull requests (no live GitHub call per
 * card): the same shared query as `PrPlainWords`, one for every card of a project.
 */
export function InboxPlainWords({
  projectId,
  prNumber,
  className,
}: {
  projectId: string | null;
  prNumber: number | undefined;
  className?: string;
}) {
  return (
    <PrPlainWords
      projectId={projectId ?? ""}
      prNumber={projectId ? prNumber : null}
      className={className}
    />
  );
}
