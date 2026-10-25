'use client';
/**
 * What an import did: nodes converted to Landflow types, placeholders for
 * node types Landflow doesn't have, notes, connections, and warnings
 * (dropped credentials, simplified schedules…). Shown after importing a file
 * or JSON (editor and workflows list; Landflow, n8n or Flowise) and after pasting n8n nodes, with the nodes the
 * governance policy blocks.
 */
import type { ReactNode } from 'react';
import { create } from 'zustand';
import { ArrowRight, Ban, CircleCheck, CircleDashed, FileJson, TriangleAlert } from 'lucide-react';
import type { ImportReport } from '@/lib/shared/types';
import { Dialog } from '../agents/dialog';
import { Button } from '../ui/button';
import { SectionLabel } from '../ui/inputs';

interface ReportState {
  report?: ImportReport;
  title?: string;
  action?: { label: string; onClick: () => void };
}

const useReport = create<ReportState>(() => ({}));

/** Open the report dialog (mount <ImportReportDialog /> once on the page). */
export function showImportReport(report: ImportReport, title: string, action?: ReportState['action']) {
  useReport.setState({ report, title, action });
}

export function ImportReportDialog() {
  const { report, title, action } = useReport();
  if (!report) return null;
  const close = () => useReport.setState({ report: undefined, action: undefined });
  return (
    <Dialog
      title={title ?? 'Import report'}
      subtitle={report.format === 'n8n' ? 'Converted from n8n' : report.format === 'flowise' ? 'Converted from Flowise' : 'Landflow workflow JSON'}
      icon={<FileJson className="size-5 text-t2" />}
      onClose={close}
      width={620}
      footer={
        <>
          <Button variant={action ? 'ghost' : 'primary'} onClick={close}>
            {action ? 'Close' : 'Done'}
          </Button>
          {action && (
            <Button
              variant="primary"
              onClick={() => {
                close();
                action.onClick();
              }}
            >
              {action.label}
            </Button>
          )}
        </>
      }
    >
      <ImportReportView report={report} />
    </Dialog>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: 'warn' }) {
  return (
    <div className="rounded-xl border border-hair bg-wl px-3 py-2">
      <div className={tone === 'warn' && value ? 'text-[18px] font-semibold text-warn' : 'text-[18px] font-semibold text-t1'}>{value}</div>
      <div className="text-[12px] text-t3">{label}</div>
    </div>
  );
}

function Group({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        {icon}
        <SectionLabel>{title}</SectionLabel>
      </div>
      {children}
    </div>
  );
}

/** The report's body, also used inline in the import dialog. */
export function ImportReportView({ report }: { report: ImportReport }) {
  const mapped = report.format === 'landflow' ? [] : report.mapped;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-2">
        <Stat value={report.mapped.length} label={report.format === 'landflow' ? 'nodes' : 'nodes mapped'} />
        <Stat value={report.placeholders.length} label="placeholders" tone="warn" />
        <Stat value={report.connections} label="connections" />
        <Stat value={report.stickyNotes} label="sticky notes" />
      </div>
      {report.placeholders.length > 0 && (
        <Group icon={<CircleDashed className="size-3.5 text-warn" />} title="Placeholders">
          <p className="text-[12px] leading-snug text-t3">
            Landflow has no equivalent for these nodes. They were added as disabled No Operation nodes with the original type and parameters in their notes, so data passes
            through them until you replace them.
          </p>
          <div className="space-y-1">
            {report.placeholders.map((p) => (
              <div key={p.name} className="flex items-center gap-2 rounded-lg border border-warnbd bg-warndim px-2.5 py-1.5 text-[12px]">
                <span className="font-semibold text-t1">{p.name}</span>
                <span className="ml-auto truncate font-mono text-[11px] text-t3">{p.type}</span>
              </div>
            ))}
          </div>
        </Group>
      )}
      {(report.blocked?.length ?? 0) > 0 && (
        <Group icon={<Ban className="size-3.5 text-rd" />} title="Blocked by policy">
          <p className="text-[12px] leading-snug text-t3">The governance policy (Settings → Governance) doesn’t allow these nodes: the workflow saves, but it can’t be published and they fail when run.</p>
          <div className="space-y-1">
            {report.blocked!.map((b) => (
              <div key={b.name} className="flex items-center gap-2 rounded-lg border border-rdbd bg-rddim px-2.5 py-1.5 text-[12px]" title={b.reason}>
                <span className="font-semibold text-t1">{b.name}</span>
                <span className="truncate text-t3">{b.reason}</span>
                <span className="ml-auto truncate font-mono text-[11px] text-t3">{b.type}</span>
              </div>
            ))}
          </div>
        </Group>
      )}
      {report.warnings.length > 0 && (
        <Group icon={<TriangleAlert className="size-3.5 text-warn" />} title={`Warnings (${report.warnings.length})`}>
          <ul className="max-h-[200px] space-y-1 overflow-y-auto">
            {report.warnings.map((warning, i) => (
              <li key={i} className="rounded-lg border border-hair bg-wl px-2.5 py-1.5 text-[12px] leading-snug text-t2">
                {warning}
              </li>
            ))}
          </ul>
        </Group>
      )}
      {mapped.length > 0 && (
        <Group icon={<CircleCheck className="size-3.5 text-gn" />} title="Mapped">
          <div className="max-h-[220px] space-y-0.5 overflow-y-auto">
            {mapped.map((m) => (
              <div key={m.name} className="flex min-w-0 items-center gap-2 px-1 py-0.5 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-semibold text-t1">{m.name}</span>
                <span className="truncate font-mono text-[11px] text-t3">{m.from}</span>
                <ArrowRight className="size-3 shrink-0 text-t3" />
                <span className="truncate font-mono text-[11px] text-t2">{m.to}</span>
              </div>
            ))}
          </div>
        </Group>
      )}
      {!report.placeholders.length && !report.warnings.length && (
        <div className="flex items-center gap-2 rounded-lg border border-gnbd bg-gndim px-3 py-2 text-[12px] text-gn">
          <CircleCheck className="size-3.5" /> Everything was imported.
        </div>
      )}
    </div>
  );
}
