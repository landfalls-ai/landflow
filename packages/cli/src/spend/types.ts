/**
 * What `landflow spend` reads of `GET /api/brain/my-spend` (the same answer as `GET /api/insights/ai/me`): the CLI never
 * imports the web app, so it declares the part it uses. The wire's own subset is `my-spend-wire.ts`.
 */
import type { MySpendPeriod, MySpendTotals } from './my-spend-wire';

export interface SpendTotals extends MySpendTotals {
  runs?: number;
}
export interface SpendRow extends SpendTotals {
  key: string;
  label: string;
}
export interface SpendForecast {
  p50: number;
  early?: boolean;
}
export interface SpendCap {
  id: string;
  subject: string;
  period: 'day' | 'month';
  metric: 'cost' | 'tokens';
  max: number;
  used: number;
  forecast?: SpendForecast;
  pace?: number;
  reachesOn?: string;
}
export interface MySpend {
  today: SpendTotals;
  month: SpendTotals;
  period: MySpendPeriod;
  from: string;
  to: string;
  byModel: SpendRow[];
  byPurpose?: SpendRow[];
  caps: SpendCap[];
  monthEnd?: string;
}
