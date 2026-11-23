/** A task's wake-up as the dialog offers it (docs/projects-and-goals.md#the-tasks-tab-and-needs-you): four presets and a custom cron. Pure. */
export const WAKE_PRESETS = ['none', 'daily', 'weekdays', 'weekly', 'custom'] as const;
export type WakePreset = (typeof WAKE_PRESETS)[number];

export const WAKE_PRESET_LABELS: Record<WakePreset, string> = { none: 'None', daily: 'Daily 9:00', weekdays: 'Weekdays 9:00', weekly: 'Weekly Monday 9:00', custom: 'Custom' };

const CRON: Record<'daily' | 'weekdays' | 'weekly', string> = { daily: '0 9 * * *', weekdays: '0 9 * * 1-5', weekly: '0 9 * * 1' };

/** The preset a cron is: `none` without one, the matching preset, else `custom`. */
export function cronPreset(cron?: string | null): WakePreset {
  const text = cron?.trim().replace(/\s+/g, ' ');
  if (!text) return 'none';
  const found = (Object.keys(CRON) as Array<keyof typeof CRON>).find((k) => CRON[k] === text);
  return found ?? 'custom';
}

/** The cron a preset stands for; `undefined` for `none` and `custom` (the person types that one). */
export function presetCron(preset: WakePreset): string | undefined {
  return preset === 'daily' || preset === 'weekdays' || preset === 'weekly' ? CRON[preset] : undefined;
}

/** The line under the wake-up choice. */
export const WAKE_NOTE = 'A wake-up only asks: the agent runs after someone approves it.';
