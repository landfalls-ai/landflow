/**
 * `LANDFLOW_NOTION_WRITE_LOG=<file>`: a test and live-check aid. Every write the client sends appends one JSON line
 * `{ at, method, pathTemplate, targetId, parentId }`: ids only, never a body, never a header.
 */
import { appendFileSync } from 'node:fs';
import { envString } from '../config';
import { logger } from '../telemetry';

export interface WriteLogLine {
  at: string;
  method: string;
  pathTemplate: string;
  targetId?: string;
  parentId?: string;
}

export function logNotionWrite(line: Omit<WriteLogLine, 'at'>): void {
  const file = envString('LANDFLOW_NOTION_WRITE_LOG');
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
  } catch (error) {
    logger.warn('notion write log not written', { error: (error as Error).message });
  }
}
