/**
 * The Platform analyst's chat in the new look (docs/second-brain.md#the-analyst-agent): which sources it can read, how many
 * it has looked across in a turn, and the chart of its answer. The numbers come from the results of the tools the analyst
 * really called (lib/server/brain/analyst.ts: `usage_report`, `search_facts`, `workflow_knowledge`, `open_suggestions`),
 * never from the model's prose; the prose only supplies the answer sentence and its drivers.
 */

export type AnalystSource = 'runs' | 'usage' | 'facts' | 'suggestions' | 'notebook';

export const ANALYST_SOURCE_LABEL: Record<AnalystSource, string> = {
  runs: 'Runs',
  usage: 'Usage & cost',
  facts: 'Facts',
  suggestions: 'Suggestions',
  notebook: 'Team notebook',
};

const ORDER: AnalystSource[] = ['runs', 'usage', 'facts', 'suggestions', 'notebook'];
const USAGE_NODE = 'core.landflowUsage';

/** The sources one tool reads, by the name the model calls it. */
export function sourcesOfTool(tool: string): AnalystSource[] {
  const name = tool.toLowerCase();
  if (name.startsWith('usage_report')) return ['runs', 'usage'];
  if (name.startsWith('workflow_knowledge')) return ['runs', 'facts'];
  if (name.startsWith('search_facts') || name.startsWith('entity_knowledge') || name === 'entities' || name.startsWith('note_entity')) return ['facts'];
  if (name.startsWith('open_suggestions') || name.startsWith('suggest_improvement')) return ['suggestions'];
  if (name.includes('notebook')) return ['notebook'];
  return [];
}

/** The distinct sources of these tool names, in the order the chips show them. */
export function sourcesOf(tools: string[]): AnalystSource[] {
  const found = new Set(tools.flatMap(sourcesOfTool));
  return ORDER.filter((s) => found.has(s));
}

/** The analyst is an ordinary agent; it is recognised by its tools: a Landflow Usage tool named usage_report. */
export function isAnalyst(tools: Array<{ type?: string; name?: string; nodeType?: string }> | undefined): boolean {
  return Boolean(tools?.some((t) => t.type === 'node' && t.nodeType === USAGE_NODE && (t.name ?? '').toLowerCase().startsWith('usage_report')));
}

/** A tool call as the chart reads it: the name the model called, its arguments and what came back. */
export interface AnalystToolResult {
  tool: string;
  input?: Record<string, unknown>;
  output?: unknown;
}

export interface AnalystPoint {
  label: string;
  value: number;
  key?: string;
}

export interface AnalystChart {
  /** What the bars measure, and how to write a value. */
  metric: 'cost' | 'failures' | 'count';
  metricLabel: string;
  groupBy: string;
  points: AnalystPoint[];
  total: number;
  /** A budget or target the results state; the chart draws it dashed. */
  budget?: number;
  /** "This week", "Last 30 days"; absent when the result carries no dates. */
  period?: string;
  /** The workflow the answer is about, when a result names one. */
  scope?: { workflowId?: string; name?: string };
}

const MAX_POINTS = 14;
const DAY_MS = 86_400_000;

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** A tool output is an object, or JSON text of one. */
function parsed(output: unknown): Record<string, unknown> | undefined {
  if (typeof output === 'string') {
    try {
      return record(JSON.parse(output));
    } catch {
      return undefined;
    }
  }
  return record(Array.isArray(output) && output.length === 1 ? output[0] : output);
}

export function periodLabel(from: unknown, to: unknown): string | undefined {
  const a = typeof from === 'string' ? Date.parse(from) : NaN;
  const b = typeof to === 'string' ? Date.parse(to) : NaN;
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return undefined;
  const days = Math.round((b - a) / DAY_MS);
  if (days === 7) return 'This week';
  if (days === 1) return 'Last day';
  return `Last ${days} days`;
}

/** A budget the results state: a number named budget, costBudget or budgetUsd on a result or on a workflow's profile. */
function budgetOf(result: Record<string, unknown>): number | undefined {
  for (const holder of [result, record(result.profile)]) {
    if (!holder) continue;
    for (const key of ['budget', 'costBudget', 'budgetUsd', 'target']) {
      const v = num(holder[key]);
      if (v !== undefined && v > 0) return v;
    }
  }
  return undefined;
}

const dayLabel = (key: string) => (/^\d{4}-\d{2}-\d{2}/.test(key) ? key.slice(5, 10) : key);

/**
 * The chart of an answer from the results of the tools it called, or nothing when no usage report with at least two
 * groups came back. Bars are cost when the report has any, else failures, else counts; days stay in time order, other
 * groups run from the largest down.
 */
export function analystChart(results: AnalystToolResult[]): AnalystChart | undefined {
  let report: Record<string, unknown> | undefined;
  for (const r of [...results].reverse()) {
    if (!r.tool.toLowerCase().startsWith('usage_report')) continue;
    const out = parsed(r.output);
    if (out && Array.isArray(out.rows) && out.rows.length >= 2) {
      report = out;
      break;
    }
  }
  if (!report) return undefined;
  const rows = (report.rows as unknown[]).map(record).filter((r): r is Record<string, unknown> => Boolean(r));
  const totals = record(report.totals);
  const sum = (field: string) => rows.reduce((n, r) => n + (num(r[field]) ?? 0), 0);
  const metric: AnalystChart['metric'] = (num(totals?.cost) ?? sum('cost')) > 0 ? 'cost' : (num(totals?.failures) ?? sum('failures')) > 0 ? 'failures' : 'count';
  const groupBy = String(report.groupBy ?? '');
  let points: AnalystPoint[] = rows.map((r) => {
    const key = String(r.key ?? '');
    return { key, label: groupBy === 'day' ? dayLabel(key) : String(r.label ?? key) || key, value: num(r[metric]) ?? 0 };
  });
  points = groupBy === 'day' ? points.sort((a, b) => a.key!.localeCompare(b.key!)).slice(-MAX_POINTS) : points.sort((a, b) => b.value - a.value).slice(0, 8);
  if (points.every((p) => p.value === 0)) return undefined;

  let budget: number | undefined;
  let scope: AnalystChart['scope'];
  for (const r of results) {
    const out = parsed(r.output);
    if (!out) continue;
    budget ??= budgetOf(out);
    if (r.tool.toLowerCase().startsWith('workflow_knowledge') && typeof out.name === 'string') {
      const id = r.input?.workflowId;
      scope = { name: out.name, ...(typeof id === 'string' && id && { workflowId: id }) };
    }
  }
  const period = periodLabel(report.from, report.to);
  return {
    metric,
    metricLabel: metric === 'cost' ? 'Cost (USD)' : metric === 'failures' ? 'Failures' : 'Events',
    groupBy,
    points,
    total: num(totals?.[metric]) ?? sum(metric),
    ...(budget !== undefined && { budget }),
    ...(period && { period }),
    ...(scope && { scope }),
  };
}

/** The line above the chart: "This week · Tech Review Workflow". */
export function chartHeading(chart: AnalystChart): string {
  return [chart.period, chart.scope?.name ?? (chart.groupBy ? `by ${chart.groupBy}` : undefined)].filter(Boolean).join(' · ');
}

/** The link for "Open the runs": the executions list, filtered to the workflow when a result names one. */
export function runsHref(chart?: Pick<AnalystChart, 'scope'>): string {
  const id = chart?.scope?.workflowId;
  return id ? `/executions?workflowId=${encodeURIComponent(id)}` : '/executions';
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/;

/** The model's answer split into the sentence(s) and up to two of its own bullet lines (the drivers). */
export function splitAnswer(text: string): { answer: string; drivers: string[] } {
  const drivers: string[] = [];
  const rest: string[] = [];
  for (const line of text.split('\n')) {
    const m = BULLET.exec(line);
    if (m) drivers.push(m[1].replace(/\*\*/g, ''));
    else rest.push(line);
  }
  return { answer: rest.join('\n').replace(/\n{3,}/g, '\n\n').trim(), drivers: drivers.slice(0, 2) };
}

export function formatMetric(metric: AnalystChart['metric'], value: number): string {
  if (metric === 'cost') return value >= 100 ? `$${Math.round(value)}` : value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(1);
}
