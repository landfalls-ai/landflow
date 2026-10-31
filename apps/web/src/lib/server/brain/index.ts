/**
 * The second brain (docs/second-brain.md): the leader runs it (bootstrap's `leaderService`). On start it fills the ledger
 * once from what is on disk; then every LANDFLOW_BRAIN_INTERVAL_MINUTES (60) it rolls the ledger up, prunes it, runs the
 * detectors, expires stale suggestions and checks the effect of applied ones, and once a day it studies (./study.ts).
 * POST /api/brain/run does any of it now.
 */
import type { LanguageModel } from '@landflow/engine';
import type { BrainStatus, DetectorId } from '../../shared/brain';
import { DETECTORS } from '../../shared/brain';
import { database, type Database } from '../db';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { backfillUsage } from '../usage/backfill';
import { brainEnabled } from '../usage/ledger';
import { ledgerSize, pruneUsage, rollupRecent } from '../usage/query';
import { DETECTOR_RUNS, detectContext, type Finding } from './detectors';
import { countFacts } from './facts';
import { checkEffects, detectorStats, expireStale, upsertProposal } from './proposals';
import { study, type StudyResult } from './study';
import { brainModelName, enrichFindings } from './writer';

const DAY_MS = 86_400_000;
const KEYS = { detect: 'brain.lastDetect', study: 'brain.lastStudy', effects: 'brain.lastEffects' } as const;

export const intervalMinutes = () => {
  const n = Number(process.env.LANDFLOW_BRAIN_INTERVAL_MINUTES);
  return Number.isFinite(n) && n >= 1 ? n : 60;
};

function stamp(key: string, db: Database, at = new Date().toISOString()) {
  db.upsert('meta', { key, value: at });
}

const stamped = (key: string, db: Database) => db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;

export interface DetectResult {
  found: number;
  saved: number;
  held: number;
  byDetector: Partial<Record<DetectorId, number>>;
  durationMs: number;
}

/** Run the detectors, let the model enrich what needs it, and keep the suggestions. */
export async function runDetectors(options: { model?: LanguageModel; db?: Database; now?: number; only?: DetectorId[]; enrich?: boolean; signal?: AbortSignal } = {}): Promise<DetectResult> {
  const db = options.db ?? database();
  const started = Date.now();
  const quiet = Object.fromEntries(detectorStats(db).map((s) => [s.id, s.quiet])) as Record<DetectorId, number>;
  const ctx = detectContext(quiet, db, options.now);
  const findings: Finding[] = [];
  const byDetector: Partial<Record<DetectorId, number>> = {};
  for (const id of options.only ?? DETECTORS) {
    try {
      const found = DETECTOR_RUNS[id](ctx);
      byDetector[id] = found.length;
      findings.push(...found);
    } catch (error) {
      logger.warn('a brain detector failed', { error, 'landflow.brain.detector': id });
    }
  }
  const enriched = options.enrich === false ? findings : await enrichFindings(findings, { model: options.model, signal: options.signal });
  let saved = 0;
  for (const finding of enriched) if (upsertProposal(finding.proposal, db, options.now)) saved++;
  stamp(KEYS.detect, db);
  return { found: findings.length, saved, held: findings.length - saved, byDetector, durationMs: Date.now() - started };
}

export interface RunResult {
  detect?: DetectResult;
  study?: StudyResult;
  expired?: number;
  effects?: number;
  pruned?: number;
}

/** Run parts of the brain now: `detect`, `study`, `effects` (with expiry and pruning), or `all`. */
export async function runBrain(what: 'detect' | 'study' | 'effects' | 'all', options: { model?: LanguageModel; db?: Database; now?: number } = {}): Promise<RunResult> {
  const db = options.db ?? database();
  const result: RunResult = {};
  if (what === 'effects' || what === 'all') {
    rollupRecent(db);
    result.pruned = pruneUsage(db, options.now);
    result.expired = expireStale(db, options.now);
    result.effects = checkEffects(db, options.now);
    stamp(KEYS.effects, db);
  }
  if (what === 'study' || what === 'all') {
    result.study = await study({ model: options.model, db, now: options.now });
    stamp(KEYS.study, db);
  }
  if (what === 'detect' || what === 'all') result.detect = await runDetectors({ model: options.model, db, now: options.now });
  return result;
}

export function brainStatus(db: Database = database()): BrainStatus {
  const { events, oldest } = ledgerSize(db);
  const { facts, profiles } = countFacts(db);
  const open = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'")?.n ?? 0);
  const at = (key: string) => stamped(key, db);
  return {
    enabled: brainEnabled(),
    model: brainModelName() ?? 'off',
    events,
    ...(oldest && { oldestEvent: oldest }),
    facts,
    profiles,
    open,
    ...(at(KEYS.detect) && { lastDetect: at(KEYS.detect) }),
    ...(at(KEYS.study) && { lastStudy: at(KEYS.study) }),
    ...(at(KEYS.effects) && { lastEffects: at(KEYS.effects) }),
    detectors: detectorStats(db),
  };
}

/** The leader's loop (see the module comment). */
export const brain = singleton('brain', () => {
  let timer: NodeJS.Timeout | undefined;
  let first: NodeJS.Timeout | undefined;
  let busy = false;
  const tick = async () => {
    if (busy || !brainEnabled()) return;
    busy = true;
    try {
      const db = database();
      const lastStudy = stamped(KEYS.study, db);
      const due = !lastStudy || Date.now() - Date.parse(lastStudy) >= DAY_MS;
      const result = await runBrain(due ? 'all' : 'effects', {});
      if (!due) result.detect = await runDetectors({});
      logger.info('the brain looked at the platform', {
        'landflow.brain.found': result.detect?.found ?? 0,
        'landflow.brain.saved': result.detect?.saved ?? 0,
        'landflow.brain.studied': result.study ? result.study.workflows + result.study.agents : 0,
        'landflow.brain.effects': result.effects ?? 0,
      });
    } catch (error) {
      logger.warn('the brain’s run failed', { error });
    } finally {
      busy = false;
    }
  };
  return {
    start() {
      if (!brainEnabled() || timer) return;
      try {
        backfillUsage();
      } catch (error) {
        logger.warn('the usage backfill failed', { error });
      }
      first = setTimeout(() => void tick(), 30_000);
      first.unref?.();
      timer = setInterval(() => void tick(), intervalMinutes() * 60_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      if (first) clearTimeout(first);
      timer = undefined;
      first = undefined;
    },
    tick,
  };
});
