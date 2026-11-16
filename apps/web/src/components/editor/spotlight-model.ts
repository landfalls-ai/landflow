'use client';
/**
 * SB19: the model this tab's Spotlight session uses, and the models the server offers. The pick is not saved: a reload
 * goes back to the default Settings → AI → Spotlight names, and a phone never picks (it uses the default).
 */
import { create } from 'zustand';
import { api } from '@/lib/client/api';
import type { SpotlightModel, SpotlightModels } from '@/lib/shared/spotlight-models';

interface SpotlightModelState {
  /** The session's pick; absent means the default. */
  pick?: string;
  default?: string;
  models: SpotlightModel[];
  loaded: boolean;
  load: () => Promise<void>;
  setPick: (model: string | undefined) => void;
}

export const useSpotlightModel = create<SpotlightModelState>((set, get) => ({
  models: [],
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    try {
      const list = await api<SpotlightModels>('/api/settings/spotlight');
      set({ default: list.default, models: list.models, loaded: true });
    } catch {
      // No list: Spotlight keeps using the default.
    }
  },
  // A pick of the default is no pick.
  setPick: (model) => set({ pick: model && model !== get().default ? model : undefined }),
}));

/** The pick as a request field: `{ model }` when a person picked one, nothing otherwise. */
export const pickedModel = (): { model?: string } => {
  const { pick, models } = useSpotlightModel.getState();
  // A pick the server stopped offering falls back to the default.
  return pick && models.some((m) => m.id === pick) ? { model: pick } : {};
};
