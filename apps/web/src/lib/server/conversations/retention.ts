/**
 * Conversation retention (LANDFLOW_CHAT_RETENTION_DAYS, default 90): conversations whose last message is older go, with
 * their items. The leader runs it once, a minute after boot, and then daily; `stop` clears the timer.
 */
import { envInt } from '../config';
import { singleton } from '../singleton';
import { logger } from '../telemetry';
import { deleteConversationsBefore } from './store';

const DAY_MS = 86_400_000;
const FIRST_RUN_MS = 60_000;

/** Delete what is older than the retention; 0 days keeps everything. Returns how many conversations went. */
export function pruneConversations(now = Date.now()): number {
  const days = envInt('LANDFLOW_CHAT_RETENTION_DAYS', { fallback: 90, min: 0 });
  if (days <= 0) return 0;
  return deleteConversationsBefore(new Date(now - days * DAY_MS).toISOString());
}

export const conversationRetention = singleton('conversation-retention', () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;

  function arm(delay: number) {
    timer = setTimeout(() => {
      try {
        const removed = pruneConversations();
        if (removed) logger.info('conversation retention', { removed });
      } catch (caught) {
        logger.warn('conversation retention failed', { error: (caught as Error).message });
      }
      if (!stopped) arm(DAY_MS);
    }, delay);
    timer.unref?.();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      arm(FIRST_RUN_MS);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
});
