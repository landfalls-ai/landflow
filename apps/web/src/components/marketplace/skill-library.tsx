'use client';
/** Skills installed from plugins (GET /api/skills), ready to add to an agent. */
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LibrarySkill } from '@/lib/shared/marketplace';
import { Card } from '../shell/page-header';
import { Chip } from '../ui/badge';
import { EmptyState } from '../ui/empty-state';

export function SkillLibrary({ skills }: { skills: LibrarySkill[] | undefined }) {
  const [open, setOpen] = useState<string>();
  if (!skills) return <div className="h-24 animate-pulse-soft rounded-2xl bg-wl" />;
  if (!skills.length) {
    return (
      <Card className="py-6">
        <EmptyState title="The skill library is empty" hint="Skills (SKILL.md) from installed plugins land here, with their references, ready to add to any agent." />
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
      {skills.map((skill, index) => (
        <button
          key={skill.id}
          onClick={() => setOpen((id) => (id === skill.id ? undefined : skill.id))}
          aria-expanded={open === skill.id}
          style={{ animationDelay: `${Math.min(index, 12) * 20}ms` }}
          className={cn('flex flex-col gap-1.5 rounded-2xl border border-hair bg-sf px-4 py-3 text-left transition-colors animate-fade-up hover:border-ac', open === skill.id && 'border-ac lg:col-span-2')}
        >
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 shrink-0 text-gn" />
            <span className="truncate text-[13px] font-semibold text-t1">{skill.name}</span>
            <span className="ml-auto truncate font-mono text-[11px] text-t3">{skill.source.installedId}</span>
          </div>
          <p className={cn('text-[12px] leading-snug text-t2', open !== skill.id && 'line-clamp-2')}>{skill.whenToUse}</p>
          <div className="flex flex-wrap gap-1.5">
            {(skill.references?.length ?? 0) > 0 && <Chip>{skill.references!.length} reference{skill.references!.length === 1 ? '' : 's'}</Chip>}
            {(skill.allowedTools?.length ?? 0) > 0 && <Chip mono>{skill.allowedTools!.join(', ')}</Chip>}
          </div>
          {open === skill.id && <pre className="mt-1 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-xl border border-hair bg-wl px-3 py-2 font-mono text-[11px] leading-relaxed text-t2">{skill.instructions}</pre>}
        </button>
      ))}
    </div>
  );
}
