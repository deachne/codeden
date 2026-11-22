import { create } from "zustand";
import { persist } from "zustand/middleware";

interface PreferencesState {
  /** Whether the Needs-you status dot pulses. On by default. */
  pulseNeedsYou: boolean;
  /** Per session: the finish marker whose Done banner was already shown once. */
  seenDone: Record<string, string>;
  setPulseNeedsYou: (on: boolean) => void;
  markDoneSeen: (sessionId: string, marker: string) => void;
}

/** Small display preferences, persisted per browser. */
export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      pulseNeedsYou: true,
      seenDone: {},
      setPulseNeedsYou: (pulseNeedsYou) => set({ pulseNeedsYou }),
      markDoneSeen: (sessionId, marker) =>
        set((s) =>
          s.seenDone[sessionId] === marker
            ? s
            : { seenDone: { ...s.seenDone, [sessionId]: marker } },
        ),
    }),
    { name: "codeden.preferences" },
  ),
);
