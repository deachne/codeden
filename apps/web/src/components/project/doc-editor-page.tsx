import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileWarning } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { SaveDiffDialog } from "@/components/editor/save-diff-dialog";
import { CodeEditor } from "@/components/on-demand";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/routes/page-header";

/** A project file the owner edits in a page: what the plan and the feature map pages share. */
export interface EditableDoc {
  path: string;
  exists: boolean;
  contents: string;
  pr?: { number: number } | null;
  shareError?: string | null;
}

/**
 * One editable project file (the plan, the feature map): the editor, a review step that shows
 * what changes, and the save with its notices. The page around it (title, links, sidebar) is the
 * caller's.
 */
export function DocEditorPage<T extends EditableDoc>({
  docKey,
  noun,
  icon,
  title,
  defaultPath,
  data,
  queryKey,
  save,
  testId,
  actions,
  aside,
  banner,
}: {
  /** Distinguishes the editor's state per project and file. */
  docKey: string;
  /** What the file is called in notices: "plan", "feature map". */
  noun: string;
  icon: ReactNode;
  title: string;
  defaultPath: string;
  data: T | undefined;
  queryKey: QueryKey;
  save: (contents: string) => Promise<T>;
  testId: string;
  /** Header buttons, before the save button. */
  actions: ReactNode;
  aside: ReactNode;
  /** Shown between the header and the editor, when given. */
  banner?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  // CodeMirror keeps LF line endings; compare and edit the file in that form.
  const saved = data?.contents.replace(/\r\n/g, "\n");
  useEffect(() => setDraft(saved ?? null), [saved]);
  const mutation = useMutation({
    mutationFn: () => save(draft ?? ""),
    onSuccess: (res) => {
      setReview(false);
      queryClient.setQueryData(queryKey, res);
      const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
      if (res.shareError) {
        toast.warning(`${Noun} saved on this computer`, {
          description: `It couldn't be committed to GitHub: ${res.shareError}`,
        });
      } else {
        toast.success(`${Noun} saved`, {
          description: res.pr ? `${res.path}, shared through PR #${res.pr.number}` : res.path,
        });
      }
    },
    onError: (e) => toast.error(`Couldn't save the ${noun}`, { description: e.message }),
  });
  const exists = data?.exists ?? false;
  const dirty = draft !== null && (draft !== saved || !exists);

  return (
    <>
      <PageHeader
        icon={icon}
        title={title}
        meta={<code className="font-mono">{data?.path ?? defaultPath}</code>}
        actions={
          <>
            {actions}
            <Button size="sm" disabled={!dirty} onClick={() => setReview(true)}>
              {exists ? "Review & save" : `Create ${noun} file`}
            </Button>
          </>
        }
      />
      {banner}
      {data && !exists && (
        <div className="flex items-center gap-2 border-b border-status-waiting/25 bg-status-waiting/[0.06] px-5 py-2 text-2xs">
          <FileWarning className="size-3.5 text-status-waiting" />
          No {noun} file yet. This is the template; edit it and save to create {data.path}.
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 border-r border-border" data-testid={testId}>
          {draft === null ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-40" />
            </div>
          ) : (
            <CodeEditor
              docKey={`${docKey}-${exists}`}
              value={draft}
              onChange={setDraft}
              onSave={() => dirty && setReview(true)}
            />
          )}
        </div>
        <aside className="hidden w-80 shrink-0 space-y-3 overflow-y-auto p-5 text-[13px] text-muted-foreground scroll-thin lg:block">
          {aside}
        </aside>
      </div>
      <SaveDiffDialog
        open={review}
        onOpenChange={setReview}
        path={data?.path ?? defaultPath}
        before={exists ? (data?.contents ?? "") : ""}
        after={draft ?? ""}
        onConfirm={() => mutation.mutate()}
        saving={mutation.isPending}
      />
    </>
  );
}
