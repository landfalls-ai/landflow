/**
 * Edit locks: one editor tab at a time edits a workflow, everyone else gets it read-only. The tab holding the lock
 * heartbeats (POST /api/workflows/<id>/lock every 10 s) and releases it when it closes; a lock not renewed for 30 s
 * expires, so a crashed tab frees it too. Admins (and the holder, from another tab) can take over. Changes go out
 * as `lock` events on the live event stream. Locks live in memory: the host is one process, and editors re-acquire
 * after a restart on their next heartbeat.
 */
import type { EditLockView } from '../../shared/auth';
import { bus } from '../bus';
import { singleton } from '../singleton';

export const LOCK_TTL_MS = 30_000;
export const LOCK_HEARTBEAT_MS = 10_000;

export type LockResult = { mine: true; lock: EditLockView } | { mine: false; lock: EditLockView };

class EditLocks {
  private readonly locks = new Map<string, EditLockView>();
  private timer?: NodeJS.Timeout;

  private publish(workflowId: string, lock: EditLockView | null) {
    bus.publish({ channel: 'lock', workflowId, lock });
  }

  private live(workflowId: string, now = Date.now()): EditLockView | undefined {
    const lock = this.locks.get(workflowId);
    if (lock && Date.parse(lock.expiresAt) <= now) {
      this.locks.delete(workflowId);
      this.publish(workflowId, null);
      return undefined;
    }
    return lock;
  }

  private sweep() {
    const now = Date.now();
    for (const id of [...this.locks.keys()]) this.live(id, now);
    if (!this.locks.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get(workflowId: string): EditLockView | undefined {
    return this.live(workflowId);
  }

  /**
   * Take or renew the lock for `tabId`. Free (or expired) → it's taken. Held by this tab → renewed. Held by another
   * tab → not taken, unless `takeover` (the route checks the caller may).
   */
  acquire(workflowId: string, holder: { userId: string; userName: string; tabId: string }, options: { takeover?: boolean; now?: number } = {}): LockResult {
    const now = options.now ?? Date.now();
    const current = this.live(workflowId, now);
    if (current && current.tabId !== holder.tabId && !options.takeover) return { mine: false, lock: current };
    const renewed = current?.tabId === holder.tabId;
    const lock: EditLockView = {
      workflowId,
      userId: holder.userId,
      userName: holder.userName,
      tabId: holder.tabId,
      since: renewed ? current.since : new Date(now).toISOString(),
      expiresAt: new Date(now + LOCK_TTL_MS).toISOString(),
    };
    this.locks.set(workflowId, lock);
    if (!renewed) this.publish(workflowId, lock);
    if (!this.timer) {
      this.timer = setInterval(() => this.sweep(), 5_000);
      this.timer.unref?.();
    }
    return { mine: true, lock };
  }

  /** Release the lock if `tabId` holds it. */
  release(workflowId: string, tabId: string): boolean {
    const current = this.live(workflowId);
    if (!current || current.tabId !== tabId) return false;
    this.locks.delete(workflowId);
    this.publish(workflowId, null);
    return true;
  }

  /** Drop every lock a user holds (they were removed). */
  releaseUser(userId: string) {
    for (const [id, lock] of [...this.locks]) {
      if (lock.userId !== userId) continue;
      this.locks.delete(id);
      this.publish(id, null);
    }
  }

  /** Tests. */
  clear() {
    this.locks.clear();
  }
}

export const editLocks = singleton('edit-locks', () => new EditLocks());
