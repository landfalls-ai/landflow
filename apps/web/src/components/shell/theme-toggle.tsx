'use client';
import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';

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

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    setTheme(current === 'light' || current === 'dark' ? current : 'system');
  }, []);
  return (
    <div className="flex w-fit gap-0.5 rounded-lg border border-hair bg-wl p-0.5" role="radiogroup" aria-label="Theme">
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          role="radio"
          aria-checked={theme === value}
          title={label}
          onClick={() => {
            setTheme(value);
            apply(value);
          }}
          className={cn('grid size-6 place-items-center rounded-md border border-transparent text-t3 transition-colors hover:text-t1', theme === value && 'border-bd bg-sf text-t1 shadow-[0_1px_2px_var(--hair)]')}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
