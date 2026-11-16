/**
 * `landflow spend [--period 24h|7d|30d|90d]`: your own AI spend (today, this month, the period by model, your caps with
 * their forecast) from `GET /api/brain/my-spend`. Needs the `brain:read` scope. Only your own calls: other people's spend
 * is on the AI page. Numbers and names only.
 */
import { flag, type Command, type Context } from '../command';
import { usage } from '../errors';
import { fields, plural, table } from '../output';
import { MY_SPEND_PATH, MY_SPEND_PERIODS, type MySpendPeriod } from '../spend/my-spend-wire';
import type { MySpend, SpendCap, SpendTotals } from '../spend/types';

const money = (n: number) => (!n ? '$0' : n < 0.0001 ? '<$0.0001' : n < 1 ? `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}` : `$${n.toFixed(2)}`);
const count = (n: number) => n.toLocaleString('en-US');
const amount = (metric: 'cost' | 'tokens', n: number) => (metric === 'cost' ? money(n) : `${count(Math.round(n))} tokens`);
const totals = (t: SpendTotals) => `${money(t.cost)} (${plural(t.calls, 'call')}${t.unpricedCalls ? `, ${t.unpricedCalls} not priced` : ''})`;

function capLine(cap: SpendCap): string {
  const used = `${amount(cap.metric, cap.used)} of ${amount(cap.metric, cap.max)}`;
  if (cap.forecast) return `${used}; forecast ${amount(cap.metric, cap.forecast.p50)}${cap.forecast.early ? ' (early)' : ''}, ${cap.reachesOn ? `reaches it on ${cap.reachesOn}` : 'stays under'}`;
  if (cap.pace !== undefined) return `${used}; pace ${amount(cap.metric, cap.pace)} by tonight`;
  return used;
}

function human(spend: MySpend): string {
  const models = table(
    spend.byModel,
    [
      { label: 'model', value: (r) => r.label, max: 50 },
      { label: 'calls', value: (r) => r.calls, align: 'right' },
      { label: 'in tokens', value: (r) => count(r.inputTokens), align: 'right' },
      { label: 'out tokens', value: (r) => count(r.outputTokens), align: 'right' },
      { label: 'cost', value: (r) => (r.unpricedCalls && !r.cost ? 'not priced' : money(r.cost)), align: 'right' },
    ],
    'No calls in this period.',
  );
  const caps = spend.caps.length ? spend.caps.map((cap) => `  ${cap.subject} (${cap.period === 'day' ? 'daily' : 'monthly'}): ${capLine(cap)}`).join('\n') : '  none';
  return [
    fields([
      ['Today', totals(spend.today)],
      ['This month', totals(spend.month)],
    ]),
    '',
    `By model, ${spend.period} (${spend.from} to ${spend.to}):`,
    models,
    '',
    'Your caps:',
    caps,
  ].join('\n');
}

const spend: Command = {
  name: 'spend',
  summary: 'Your own AI spend: today, this month, by model, your caps',
  usage: '[--period 24h|7d|30d|90d]',
  details: 'Reads GET /api/brain/my-spend (the brain:read scope). Only your own calls and caps; other people’s spend is on the AI page.',
  flags: { period: flag.string('The period for the by-model table: 24h, 7d (default), 30d or 90d', 'period') },
  args: { max: 0 },
  async run(ctx: Context) {
    const period = (ctx.flags.period as string | undefined) ?? '7d';
    if (!(MY_SPEND_PERIODS as readonly string[]).includes(period)) throw usage(`--period is ${MY_SPEND_PERIODS.join(', ')}, got "${period}"`);
    const body = await ctx.client.get<MySpend>(MY_SPEND_PATH, { period: period as MySpendPeriod });
    const answer: MySpend = { ...body, byModel: body.byModel ?? [], caps: body.caps ?? [] };
    return { data: { ...answer }, human: () => human(answer) };
  },
};

export const spendCommands: Command[] = [spend];
