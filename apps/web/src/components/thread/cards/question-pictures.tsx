import {
  ANSWER_PICTURE_REFUSALS,
  type AnswerPicture,
  answerPictureProblem,
  type ImageMediaType,
  MAX_ANSWER_PICTURES,
} from "@codeden/contracts";
import { ImagePlus, X } from "lucide-react";
import { useRef, useState } from "react";
import { base64Of, readDataUrl } from "@/components/composer/attachments";
import { Button } from "@/components/ui/button";

/** A picture picked for an answer, with the data URL its preview shows. */
export interface PickedPicture {
  id: string;
  name: string;
  mediaType: ImageMediaType;
  data: string;
  previewUrl: string;
}

let counter = 0;

/** The pictures as the answer carries them. */
export const toAnswerPictures = (pictures: PickedPicture[]): AnswerPicture[] =>
  pictures.map((p) => ({
    type: "image",
    mediaType: p.mediaType,
    name: p.name,
    source: { type: "base64", data: p.data },
  }));

/**
 * The pictures attached to one answer: picked or pasted files that are images within the size
 * limit are kept (with a preview); any other file is refused with a plain message in `problem`.
 */
export function useAnswerPictures() {
  const [pictures, setPictures] = useState<PickedPicture[]>([]);
  const [problem, setProblem] = useState<string>();

  const add = async (files: File[]) => {
    let refusal: string | undefined;
    const added: PickedPicture[] = [];
    for (const file of files) {
      if (pictures.length + added.length >= MAX_ANSWER_PICTURES) {
        refusal = ANSWER_PICTURE_REFUSALS.tooMany;
        break;
      }
      const issue = answerPictureProblem(file.type, file.size);
      if (issue) {
        refusal = issue;
        continue;
      }
      try {
        const url = await readDataUrl(file);
        added.push({
          id: `pic-${counter++}`,
          name: file.name || "picture.png",
          mediaType: file.type as ImageMediaType,
          data: base64Of(url),
          previewUrl: url,
        });
      } catch {
        refusal = "Couldn't read that picture. Try another one.";
      }
    }
    setProblem(refusal);
    if (added.length > 0) setPictures((prev) => [...prev, ...added]);
  };
  const remove = (id: string) => {
    setPictures((prev) => prev.filter((p) => p.id !== id));
    setProblem(undefined);
  };
  return { pictures, problem, add, remove };
}

/**
 * The attach button, the previews with a way to take each off, and the plain message when a file
 * was refused. When the assistant can't look at pictures, a plain note stands in for the button.
 */
export function PicturePicker({
  pictures,
  problem,
  supported,
  disabled,
  onAdd,
  onRemove,
}: {
  pictures: PickedPicture[];
  problem: string | undefined;
  supported: boolean;
  disabled: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  if (!supported) {
    return (
      <p className="border-t border-border px-3.5 py-2 text-2xs text-muted-foreground">
        {ANSWER_PICTURE_REFUSALS.unsupported}
      </p>
    );
  }
  return (
    <div className="space-y-2 border-t border-border px-3.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          aria-label="Choose a picture"
          onChange={(e) => {
            onAdd(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus />
          Attach a picture
        </Button>
        {pictures.map((p) => (
          <div key={p.id} className="group relative animate-rise">
            <img
              src={p.previewUrl}
              alt={p.name}
              className="size-12 rounded-lg border border-border object-cover"
            />
            <button
              type="button"
              aria-label={`Remove ${p.name}`}
              disabled={disabled}
              onClick={() => onRemove(p.id)}
              className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-sm hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>
      {problem && (
        <p role="alert" className="text-2xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
