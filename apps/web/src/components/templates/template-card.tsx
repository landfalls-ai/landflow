'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Ban, Globe, HardDrive, KeyRound, LayoutTemplate, PackageX, Store } from 'lucide-react';
import { nodeColor, tint } from '@/lib/client/node-style';
import { TEMPLATE_CATEGORIES, type TemplateSummary } from '@/lib/shared/templates';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '@/components/agents/avatar';
import { Badge, Chip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NodeIcon } from '@/components/ui/icon';
import { UseTemplateDialog } from './use-template-dialog';
import { plainText, useTemplateDetail } from './use-templates';

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

/** Saved templates: the project they belong to, or instance-wide; a marketplace plugin's flows say which plugin. */
export function SourceBadge({ template, remoteLabel }: { template: Pick<TemplateSummary, 'source' | 'projectId' | 'projectName' | 'origin'>; remoteLabel?: string }) {
  if (template.origin)
    return (
      <Badge tone="accent" title={`A flow of the “${template.origin.plugin}” plugin from the ${template.origin.marketplace} marketplace. Uninstalling the plugin removes it.`}>
        <Store className="size-3" /> <span className="max-w-[120px] truncate">{template.origin.plugin}</span>
      </Badge>
    );
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

/** The "Use template" setup for a card, loading the template when it opens. */
function UseFromCard({ id, folderId, projectId, onClose }: { id: string; folderId?: string; projectId?: string; onClose: () => void }) {
  const { template } = useTemplateDetail(id, projectId);
  return template ? <UseTemplateDialog template={template} folderId={folderId} projectId={projectId ?? template.projectId} onClose={onClose} /> : null;
}

/**
 * A team template's card (docs/templates.md#team-templates): the members' faces in a row, what the person picks, and a
 * "Use template" button that opens the same setup as the template's page, which asks for each credential.
 */
function TeamCard({ template, index, href, folderId, projectId }: { template: TemplateSummary; index: number; href: string; folderId?: string; projectId?: string }) {
  const [using, setUsing] = useState(false);
  const team = template.team!;
  return (
    <div
      style={{ animationDelay: `${Math.min(index, 18) * 15}ms` }}
      data-testid="team-template-card"
      className={cn('group relative flex min-h-[172px] flex-col gap-2.5 rounded-2xl border border-hair bg-sf px-4 py-3.5 text-left transition-colors animate-fade-up hover:border-ac', !template.usable && 'bg-sf2')}
    >
      <div className="flex items-center gap-2">
        <div className="flex items-center" aria-label={`Members: ${team.faces.map((f) => f.name).join(', ')}`}>
          {team.faces.slice(0, 6).map((face, i) => (
            <span key={`${face.name}-${i}`} title={face.name} className={cn('rounded-full ring-2 ring-[var(--sf)]', i > 0 && '-ml-2')}>
              <AgentAvatar agent={face} size={30} round />
            </span>
          ))}
          {team.faces.length > 6 && <span className="pl-1.5 text-[12px] text-t3">+{team.faces.length - 6}</span>}
        </div>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <ProblemBadge template={template} />
          <SourceBadge template={template} />
        </span>
      </div>
      <div className="min-w-0">
        <h3 className="line-clamp-2 text-[14px] font-semibold leading-snug text-t1 group-hover:text-ac">
          <Link href={href} className="after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none">
            {template.name}
          </Link>
        </h3>
        <p className="mt-1 line-clamp-3 text-[12px] leading-snug text-t2">{plainText(template.description) || 'No description.'}</p>
      </div>
      <div className="mt-auto flex flex-col gap-2">
        {team.picks.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="you-pick">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">You pick</span>
            {team.picks.map((pick) => (
              <Chip key={pick} className="py-0 text-[11px]">
                {pick}
              </Chip>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-t3">
            {team.members} members{team.hasWorkflow ? ' · with its flow' : ''}
          </span>
          <Button size="sm" variant="primary" className="relative z-10 ml-auto" disabled={!template.usable} onClick={() => setUsing(true)} title={template.usable ? undefined : template.problems.map((p) => p.message).join('\n')}>
            <LayoutTemplate className="size-3.5" /> Use template
          </Button>
        </div>
      </div>
      {using && <UseFromCard id={template.id} folderId={folderId} projectId={projectId ?? template.projectId} onClose={() => setUsing(false)} />}
    </div>
  );
}

export function TemplateCard({ template, types, index, href, remoteLabel, folderId, projectId }: { template: TemplateSummary; types: Record<string, NodeTypeInfo>; index: number; href: string; remoteLabel?: string; folderId?: string; projectId?: string }) {
  if (template.team) return <TeamCard template={template} index={index} href={href} folderId={folderId} projectId={projectId} />;
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
          <span>{template.nodeCount} node{template.nodeCount === 1 ? '' : 's'}</span>
        </span>
      </div>
    </Link>
  );
}
