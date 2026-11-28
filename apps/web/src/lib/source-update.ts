import type { SourceUpdateStatus } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { create } from "zustand";
import { useClient } from "@/lib/api";
import { useSnapshotData } from "@/lib/queries";

export const sourceUpdateKey = ["updates", "source"] as const;

/** The Update button's status: the script, new changes on GitHub, a run in progress. */
export function useSourceUpdate() {
  const client = useClient();
  // Asked again when the script setting changes, so the button appears or goes right away.
  const script = useSnapshotData((s) => s.settings?.updates.sourceScript ?? "", "");
  return useQuery({
    queryKey: [...sourceUpdateKey, script],
    queryFn: () => client.updates.source(),
    staleTime: 10 * 60_000,
    refetchInterval: 10 * 60_000,
    retry: false,
  });
}

/** Ask GitHub now (the Update box opens with a fresh answer, not one up to 10 minutes old). */
export function useRefreshSourceUpdate() {
  const client = useClient();
  const queryClient = useQueryClient();
  const script = useSnapshotData((s) => s.settings?.updates.sourceScript ?? "", "");
  return useMutation({
    mutationFn: () => client.updates.source({ refresh: true }),
    onSuccess: (status) => queryClient.setQueryData([...sourceUpdateKey, script], status),
  });
}

type Phase = "idle" | "waiting" | "slow" | "failed";

interface RestartState {
  phase: Phase;
  error: string | null;
  set: (phase: Phase, error?: string | null) => void;
}

/** The browser's side of an update: waiting for the restarted server, or the run failed. */
export const useSourceRestart = create<RestartState>()((set) => ({
  phase: "idle",
  error: null,
  set: (phase, error = null) => set({ phase, error }),
}));

/** A build takes a few minutes; after this, say it is taking long (but keep waiting). */
const SLOW_MS = 10 * 60_000;

/** Start the update script, then wait for the new server and reload the page. */
export function useRunSourceUpdate() {
  const client = useClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.updates.runSource(),
    onSuccess: (status) => {
      void queryClient.invalidateQueries({ queryKey: sourceUpdateKey });
      waitForRestart(status.bootId, () => client.updates.source());
    },
  });
}

/** Picks the wait back up after the page reloads mid-update (the status says `running`). */
export function useResumeSourceRestart(status: SourceUpdateStatus | undefined): void {
  const client = useClient();
  const running = status?.state === "running" ? status.bootId : null;
  useEffect(() => {
    if (running) waitForRestart(running, () => client.updates.source());
  }, [running, client]);
}

/**
 * Poll the status every 2 seconds. A new `bootId` means the restarted server answers: reload
 * so the new build's page loads. The same server reporting `failed` means the script stopped
 * (CodeDen kept running). While the server is down the request fails; that is expected.
 */
function waitForRestart(bootId: string, poll: () => Promise<SourceUpdateStatus>): void {
  const store = useSourceRestart.getState();
  if (store.phase === "waiting" || store.phase === "slow") return;
  store.set("waiting");
  const started = Date.now();
  const tick = async () => {
    let status: SourceUpdateStatus | null = null;
    try {
      status = await poll();
    } catch {
      // Down while it restarts.
    }
    if (status && status.bootId !== bootId) {
      window.location.reload();
      return;
    }
    if (status && status.state === "failed") {
      useSourceRestart.getState().set("failed", status.error);
      return;
    }
    if (status && status.state === "idle") {
      // The script finished without restarting CodeDen.
      useSourceRestart.getState().set("idle");
      return;
    }
    if (Date.now() - started > SLOW_MS && useSourceRestart.getState().phase === "waiting") {
      useSourceRestart.getState().set("slow");
    }
    setTimeout(() => void tick(), 2000);
  };
  setTimeout(() => void tick(), 2000);
}
