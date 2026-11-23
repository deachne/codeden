import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { SettingRow, useSettings } from "./settings-ui";

/** Same shape the settings contract accepts for `factory.ideasRepo`. */
export const IDEAS_REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** Settings > General > Ideas repository: where the scout's parked ideas are copied. */
export function IdeasRepoSetting() {
  const { settings, update } = useSettings();
  const saved = settings.factory.ideasRepo;
  const [draft, setDraft] = useState(saved);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(saved);
    setInvalid(false);
  }, [saved]);

  const commit = () => {
    const value = draft.trim();
    if (!IDEAS_REPO_PATTERN.test(value)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(value);
    if (value !== saved) update({ factory: { ideasRepo: value } });
  };

  return (
    <SettingRow
      label="Ideas repository"
      help={
        invalid
          ? "Use the form owner/name, like deachne/ideas."
          : "The GitHub repository where ideas the scout sets aside are copied as issues."
      }
    >
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        aria-invalid={invalid}
        spellCheck={false}
        className="h-8 w-56 text-xs"
        data-testid="ideas-repo"
      />
    </SettingRow>
  );
}
