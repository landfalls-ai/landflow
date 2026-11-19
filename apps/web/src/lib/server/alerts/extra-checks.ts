/**
 * Checks other features add to the alert service's ticker (a seam: the service imports nothing of them). A check is called with
 * the clock and `send` (a rule's channels); it sends what its rules ask for. The approval inbox registers its `approval` event
 * here (approval-inbox/index.ts, AP01).
 */
import type { AlertRule } from '../../shared/alerts';
import { singleton } from '../singleton';
import type { AlertNotice } from './message';

export type AlertSend = (rule: AlertRule, notice: AlertNotice) => Promise<void>;
export type ExtraCheck = (now: number, send: AlertSend) => Promise<void>;

const registry = () => singleton('alert-extra-checks', () => new Map<string, ExtraCheck>());

/** Add (or replace) a named check. */
export function registerAlertCheck(name: string, check: ExtraCheck): void {
  registry().set(name, check);
}

export const alertChecks = (): Array<[string, ExtraCheck]> => [...registry()];
