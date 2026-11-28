import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { useSourceUpdate } from "@/lib/source-update";
import { SettingRow, useSettings } from "./settings-ui";

/**
 * Settings > General > Update script: for a CodeDen run from a git checkout, a script that
 * pulls, rebuilds and restarts it. Set, it adds an Update button to the sidebar header. Only
 * the computer running CodeDen can change it (the server refuses remote devices).
 */
export function UpdateScriptSetting() {
  const { settings, update } = useSettings();
  const { data } = useSourceUpdate();
  const saved = settings.updates.sourceScript;
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);

  const commit = () => {
    const value = draft.trim();
    setDraft(value);
    if (value !== saved) update({ updates: { sourceScript: value } });
  };

  const help = data?.problem
    ? data.problem
    : "For a copy run from its own folder: a script that gets the latest, rebuilds and restarts CodeDen, like ~/Projects/codeden-update.sh. Adds an Update button to the top of the sidebar. Leave empty for no button. Can only be changed on this computer.";

  return (
    <SettingRow label="Update script" help={help}>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        aria-invalid={Boolean(data?.problem)}
        placeholder="~/path/to/update.sh"
        spellCheck={false}
        className="h-8 w-56 text-xs"
        data-testid="update-script"
      />
    </SettingRow>
  );
}
