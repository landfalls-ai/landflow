'use client';
/**
 * "Your morning": the caller's own briefing (GET /api/brain/briefing, docs/work-and-briefings.md) on Home and at the top of
 * the Brain index. The summary the nightly sync wrote (or "Live: no nightly sync yet"), then yesterday's work, related
 * colleagues and a Delivery line; an admin without the nightly workflow gets a quiet "Set up tomorrow sync".
 *
 * The logic is plain functions (`safeHref`, `collapse`, `showSetup`, `changeDelivery`) so the node tests can check it; the
 * view (`BriefingView`) is markup over props, and `BriefingCard` is the one that fetches.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, Sun } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { setPreference, usePreference } from '@/lib/client/preferences';
import { can } from '@/lib/shared/auth';
import type { Briefing, RelatedColleague, WorkItem } from '@/lib/shared/brain-work';
import type { BriefingDelivery } from '@/lib/shared/preferences';
import type { WorkflowSummary } from '@/lib/shared/types';
import { useViewer } from '../auth/viewer';
import { Card } from '../shell/page-header';
import { Chip } from '../ui/badge';
import { Button } from '../ui/button';
import { MenuItem, Popover } from '../ui/popover';
import { SectionLabel } from '../ui/inputs';

/** Lists longer than this show their first items and a "Show N more" button. */
export const COLLAPSE_AT = 3;

export const TEMPLATE_ID = 'brain-tomorrow-sync';
/** The node type that marks a workflow made from the template (summaries carry node types, not the template's id). */
const SYNC_NODE_TYPES = ['core.brainListPeople', 'brainListPeople'];

export const EMPTY_TEXT = 'Nothing yet. Work you record shows up here tomorrow.';
export const LIVE_TEXT = 'Live: no nightly sync yet';
export const SETUP_LABEL = 'Set up tomorrow sync';

const DELIVERY_LABELS: Record<BriefingDelivery, string> = { none: 'None', slack: 'Slack', email: 'Email' };
const SETUP_NOTE: Partial<Record<BriefingDelivery, string>> = {
  slack: 'Slack needs an admin to set it up on the server (a bot token); until then your briefing stays here.',
  email: 'Email needs the server’s mail settings; until an admin sets them up your briefing stays here.',
};

/** A link a briefing may show: a path or address on this instance, or github.com. Anything else is shown as plain text. */
export function safeHref(url: string | undefined, origin?: string): { href: string; external: boolean } | undefined {
  if (!url) return undefined;
  if (url.startsWith('/')) return /^\/(?![/\\])/.test(url) && !/[\\\t\r\n]/.test(url) ? { href: url, external: false } : undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  if (origin && parsed.origin === origin) {
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return path.startsWith('//') || path.includes('\\') ? undefined : { href: path, external: false };
  }
  if (parsed.protocol === 'https:' && parsed.hostname === 'github.com' && !parsed.username && !parsed.password) return { href: parsed.href, external: true };
  return undefined;
}

/** The first `limit` items, and how many are folded away (0 when expanded). */
export function collapse<T>(items: T[], expanded: boolean, limit = COLLAPSE_AT): { shown: T[]; hidden: number } {
  if (expanded || items.length <= limit) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, limit), hidden: items.length - limit };
}

/** Whether the briefing has nothing to show: no nightly text, no work of either day, nobody related. */
export function isEmpty(briefing: Briefing): boolean {
  return !briefing.summary && !briefing.today.length && !briefing.yesterday.length && !briefing.related.length;
}

/** The setup line is for admins, and only while no workflow made from the template exists. */
export function showSetup(admin: boolean, workflows: Pick<WorkflowSummary, 'nodeTypes'>[] | undefined): boolean {
  return admin && workflows !== undefined && !workflows.some((w) => w.nodeTypes.some((type) => SYNC_NODE_TYPES.includes(type)));
}

export function deliveryText(delivery: BriefingDelivery): string {
  return delivery === 'none' ? 'Delivered here only' : `Delivered here and by ${DELIVERY_LABELS[delivery]}`;
}

/** Write the choice to the person's preference `briefingDelivery`; answers what to tell them when it needs setting up. */
export async function changeDelivery(value: BriefingDelivery, save: (key: 'briefingDelivery', value: BriefingDelivery) => Promise<void> = setPreference): Promise<string | undefined> {
  await save('briefingDelivery', value);
  return SETUP_NOTE[value];
}

function ItemLink({ item, origin }: { item: WorkItem; origin?: string }) {
  const link = safeHref(item.url, origin);
  if (!link) return <span className="min-w-0 break-words text-t1">{item.title}</span>;
  const cls = 'min-w-0 break-words text-t1 hover:text-ac hover:underline';
  return link.external ? (
    <a href={link.href} target="_blank" rel="noopener noreferrer" className={cls}>
      {item.title}
    </a>
  ) : (
    <Link href={link.href} className={cls}>
      {item.title}
    </Link>
  );
}

function Folded({ count, expanded, onToggle }: { count: number; expanded: boolean; onToggle: () => void }) {
  if (!count && !expanded) return null;
  return (
    <button type="button" onClick={onToggle} aria-expanded={expanded} className="inline-flex items-center gap-1 text-[12px] text-t3 hover:text-ac max-md:min-h-11">
      {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
      {expanded ? 'Show fewer' : `Show ${count} more`}
    </button>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-t3">{title}</h3>
        <span className="text-[11px] tabular-nums text-t3">{count}</span>
      </div>
      {children}
    </section>
  );
}

function ItemList({ title, items, origin }: { title: string; items: WorkItem[]; origin?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const { shown, hidden } = collapse(items, expanded);
  return (
    <Group title={title} count={items.length}>
      <ul className="space-y-1.5">
        {shown.map((item) => (
          <li key={item.id} className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
            <ItemLink item={item} origin={origin} />
            {item.repo && <span className="font-mono text-[11px] text-t3">{item.repo}</span>}
            <span className="text-[11px] text-t3">{timeAgo(item.at)}</span>
          </li>
        ))}
      </ul>
      <Folded count={hidden} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
    </Group>
  );
}

function RelatedList({ related, origin }: { related: RelatedColleague[]; origin?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!related.length) return null;
  const { shown, hidden } = collapse(related, expanded);
  return (
    <Group title="Related" count={related.length}>
      <ul className="space-y-2">
        {shown.map((entry) => (
          <li key={`${entry.person.userId ?? entry.person.name}`} className="space-y-0.5 text-[13px]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-t1">{entry.person.name}</span>
              <Chip>
                {entry.because.type}: {entry.because.name}
              </Chip>
            </div>
            {entry.items[0] && (
              <div className="text-t2">
                <ItemLink item={entry.items[0]} origin={origin} />
              </div>
            )}
          </li>
        ))}
      </ul>
      <Folded count={hidden} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
    </Group>
  );
}

export interface BriefingViewProps {
  briefing: Briefing;
  delivery: BriefingDelivery;
  onDelivery?: (value: BriefingDelivery) => void;
  /** The setup line shows (an admin, no nightly workflow yet). */
  canSetup?: boolean;
  settingUp?: boolean;
  onSetup?: () => void;
  /** This instance's origin: a link to it stays in the app. */
  origin?: string;
}

/** The card's markup. Renders nothing when the brain is off. */
export function BriefingView({ briefing, delivery, onDelivery, canSetup, settingUp, onSetup, origin }: BriefingViewProps) {
  if (briefing.brain === 'off') return null;
  const empty = isEmpty(briefing);
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <Sun className="size-3.5 text-viz-7" />
        <SectionLabel>Your morning</SectionLabel>
      </div>

      {empty ? (
        <p className="text-[13px] text-t3">{EMPTY_TEXT}</p>
      ) : (
        <>
          {briefing.source === 'flow' && briefing.summary ? (
            <p className="whitespace-pre-line text-[13px] leading-relaxed text-t1">{briefing.summary}</p>
          ) : (
            <p className="text-[12px] text-t3">{LIVE_TEXT}</p>
          )}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ItemList title="Yesterday" items={briefing.yesterday} origin={origin} />
            <ItemList title="Today so far" items={briefing.today} origin={origin} />
            <RelatedList related={briefing.related} origin={origin} />
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-hair pt-2.5 text-[12px] text-t3">
        <span>{deliveryText(delivery)}</span>
        <span aria-hidden>·</span>
        <Popover
          align="start"
          title="Deliver my briefing"
          trigger={({ toggle, open }) => (
            <button type="button" onClick={toggle} aria-haspopup="menu" aria-expanded={open} className="text-ac hover:underline max-md:min-h-11 max-md:px-1">
              Change
            </button>
          )}
        >
          {(close) =>
            (Object.keys(DELIVERY_LABELS) as BriefingDelivery[]).map((value) => (
              <MenuItem
                key={value}
                onClick={() => {
                  close();
                  onDelivery?.(value);
                }}
                hint={value === delivery ? 'Current' : undefined}
              >
                {DELIVERY_LABELS[value]}
              </MenuItem>
            ))
          }
        </Popover>
        {canSetup && (
          <Button size="sm" variant="ghost" onClick={onSetup} loading={settingUp} className="ml-auto max-md:h-11" title="Creates the nightly workflow from the template and opens it, unpublished, for you to review">
            {SETUP_LABEL}
          </Button>
        )}
      </div>
    </Card>
  );
}

/** The card with its data: the caller's briefing, their delivery preference and, for an admin, the setup line. */
export function BriefingCard() {
  const router = useRouter();
  const viewer = useViewer();
  const delivery = usePreference('briefingDelivery');
  const [briefing, setBriefing] = useState<Briefing>();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>();
  const [settingUp, setSettingUp] = useState(false);
  const admin = can(viewer, 'settings:manage');
  const origin = typeof window === 'undefined' ? undefined : window.location.origin;

  useEffect(() => {
    api<Briefing>('/api/brain/briefing')
      .then(setBriefing)
      .catch(() => setBriefing(undefined));
  }, []);
  useEffect(() => {
    if (!admin) return;
    api<{ workflows: WorkflowSummary[] }>('/api/workflows')
      .then((r) => setWorkflows(r.workflows))
      .catch(() => setWorkflows(undefined));
  }, [admin]);

  const setup = async () => {
    setSettingUp(true);
    try {
      const made = await api<{ workflow?: { id: string } }>(`/api/templates/${TEMPLATE_ID}/use`, { method: 'POST', json: {} });
      if (!made.workflow) throw new Error('The template made no workflow');
      router.push(`/workflows/${made.workflow.id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setSettingUp(false);
    }
  };

  const choose = (value: BriefingDelivery) => {
    changeDelivery(value)
      .then((note) => note && toast.message(note))
      .catch((e: Error) => toast.error(e.message));
  };

  if (!briefing) return null;
  return <BriefingView briefing={briefing} delivery={delivery} onDelivery={choose} canSetup={showSetup(admin, workflows)} settingUp={settingUp} onSetup={() => void setup()} origin={origin} />;
}
