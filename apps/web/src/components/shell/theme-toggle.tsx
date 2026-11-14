'use client';
import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Segmented } from '../ui/segmented';

type Theme = 'system' | 'light' | 'dark';
const KEY = 'landflow-theme';

/** Runs before paint (inlined in <head>) so the page never flashes the wrong theme. */
export const themeScript = `try{var t=localStorage.getItem('${KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

function apply(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {}
}

const OPTIONS: Array<{ value: Theme; icon: typeof Sun; label: string }> = [
  { value: 'system', icon: Monitor, label: 'System' },
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
];

/** The chosen theme, read after mount (the pre-paint script set the attribute), and a setter that keeps the choice. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    setTheme(current === 'light' || current === 'dark' ? current : 'system');
  }, []);
  return [
    theme,
    (next) => {
      setTheme(next);
      apply(next);
    },
  ];
}

/** The three choices as a labelled row, for the user menu. */
export function ThemeChoice() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="px-2.5 py-1.5">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Theme</div>
      <Segmented label="Theme" size="sm" stretch value={theme} onChange={setTheme} options={OPTIONS.map(({ value, icon: Icon, label }) => ({ value, label: <Icon className="size-3.5" />, ariaLabel: label, title: label }))} />
    </div>
  );
}
