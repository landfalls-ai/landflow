'use client';
import Link from 'next/link';
import { Ban, Globe, HardDrive, KeyRound, PackageX } from 'lucide-react';
import { nodeColor, tint } from '@/lib/client/node-style';
import { TEMPLATE_CATEGORIES, type TemplateSummary } from '@/lib/shared/templates';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { cn } from '@/lib/utils';
import { Badge, Chip } from '@/components/ui/badge';
import { NodeIcon } from '@/components/ui/icon';
import { plainText } from './use-templates';

const MAX_ICONS = 6;

export const categoryName = (id: string) => TEMPLATE_CATEGORIES.find((c) => c.id === id)?.name ?? id;

/** The node types a template uses, as tinted icons (missing ones as a crossed-out box, blocked ones dimmed). */
export function TemplateNodeIcons({ nodeTypes, types, size = 'sm' }: { nodeTypes: string[]; types: Record<string, NodeTypeInfo>; size?: 'sm' | 'md' }) {
  const box = size === 'md' ? 'size-8 rounded-[10px]' : 'size-7 rounded-lg';
  return (
    <div className="flex flex-wrap items-center gap-1">
      {nodeTypes.slice(0, MAX_ICONS).map((type) => {
        const info = types[type];
        const color = nodeColor(info);
        return (
          <span
            key={type}
            title={info ? `${info.descriptor.displayName}${info.blocked ? ` (blocked: ${info.blocked})` : ''}` : `${type} (not installed)`}
            className={cn('grid place-items-center border border-hair', box, info?.blocked && 'opacity-45 grayscale')}
            style={{ background: tint(color, 12) }}
          >
            {info ? <NodeIcon icon={info.descriptor.icon} size={size === 'md' ? 16 : 14} strokeWidth={1.9} style={{ color }} /> : <PackageX className="size-3.5 text-t3" />}
          </span>
        );
      })}
      {nodeTypes.length > MAX_ICONS && <span className="pl-0.5 text-[12px] text-t3">+{nodeTypes.length - MAX_ICONS}</span>}
    </div>
  );
}

/** Why a template can't be used, as one badge. */
export function ProblemBadge({ template }: { template: Pick<TemplateSummary, 'usable' | 'problems'> }) {
  if (template.usable) return null;
  const blocked = template.problems.some((p) => p.kind === 'blocked');
  return (
    <Badge tone={blocked ? 'danger' : 'warning'} title={template.problems.map((p) => p.message).join('\n')}>
      {blocked ? <Ban className="size-3" /> : <PackageX className="size-3" />} {blocked ? 'Blocked here' : 'Needs a plugin'}
    </Badge>
  );
}

/** Saved templates: the project they belong to, or instance-wide. */
export function SourceBadge({ template, remoteLabel }: { template: Pick<TemplateSummary, 'source' | 'projectId' | 'projectName'>; remoteLabel?: string }) {
  if (template.source === 'local')
    return (
      <Badge tone="accent" title={template.projectId ? `Saved in the “${template.projectName ?? template.projectId}” project` : 'Saved here, for the whole instance'}>
        <HardDrive className="size-3" /> {template.projectId ? <span className="max-w-[120px] truncate">{template.projectName ?? 'Project'}</span> : 'Instance-wide'}
      </Badge>
    );
  if (template.source === 'remote')
    return (
      <Badge tone="neutral" title={remoteLabel && `From ${remoteLabel}`}>
        <Globe className="size-3" /> Remote
      </Badge>
    );
  return null;
}

export function TemplateCard({ template, types, index, href, remoteLabel }: { template: TemplateSummary; types: Record<string, NodeTypeInfo>; index: number; href: string; remoteLabel?: string }) {
  const credentials = template.credentials.filter((c) => !c.optional).length;
  return (
    <Link
      href={href}
      style={{ animationDelay: `${Math.min(index, 18) * 15}ms` }}
      className={cn(
        'group flex min-h-[172px] flex-col gap-2.5 rounded-2xl border border-hair bg-sf px-4 py-3.5 text-left transition-colors animate-fade-up hover:border-ac focus-visible:border-ac focus-visible:outline-none',
        !template.usable && 'bg-sf2',
      )}
    >
      <div className="flex items-start gap-2">
        <TemplateNodeIcons nodeTypes={template.nodeTypes} types={types} />
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <ProblemBadge template={template} />
          <SourceBadge template={template} remoteLabel={remoteLabel} />
        </span>
      </div>
      <div className="min-w-0">
        <h3 className="line-clamp-2 text-[14px] font-semibold leading-snug text-t1 group-hover:text-ac">{template.name}</h3>
        <p className="mt-1 line-clamp-3 text-[12px] leading-snug text-t2">{plainText(template.description) || 'No description.'}</p>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        {template.categories.slice(0, 2).map((c) => (
          <Chip key={c}>{categoryName(c)}</Chip>
        ))}
        <span className="ml-auto flex items-center gap-2.5 text-[11px] text-t3">
          {credentials > 0 && (
            <span className="inline-flex items-center gap-1" title={template.credentials.map((c) => c.name).join(', ')}>
              <KeyRound className="size-3" /> {credentials}
            </span>
          )}
          <span>
            {template.nodeCount} node{template.nodeCount === 1 ? '' : 's'}
          </span>
        </span>
      </div>
    </Link>
  );
}
