/**
 * Leader election among the mains: a Valkey key with a time to live (`leader` = `<instance>|<token>`) that the leader
 * renews every third of its TTL. The token is a fencing token: it grows with every new leadership, and the status,
 * metrics and logs carry it. The leader also stops acting on its own once its lease could have run out (its last
 * successful renewal + TTL − a safety margin), before any other main can win the key, so two mains never run the
 * leader's services at once even when Valkey is slow or unreachable.
 *
 * Failover: a leader that stops (or crashes) is replaced within TTL + TTL/3 (about 13 s with the default 10 s TTL);
 * a main shutting down resigns, and the next one takes over within TTL/3.
 */
import type { Coordinator, Leadership } from './coordinator';

export interface LeaderHooks {
  /** This instance leads now (token: its fencing token). */
  onElected?: (token: number) => void | Promise<void>;
  /** It does not lead any more (why). */
  onDemoted?: (reason: string) => void | Promise<void>;
}

export class LeaderElector {
  private leading = false;
  private token = 0;
  private holder?: string;
  private validUntil = 0;
  private timer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;
  /** Elections won since start (metrics). */
  elections = 0;

  constructor(
    private readonly coordinator: Coordinator,
    readonly id: string,
    readonly ttlMs: number,
    private readonly hooks: LeaderHooks = {},
    private readonly clock: () => number = Date.now,
  ) {}

  /** Whether this instance leads and its lease is still certainly valid. */
  isLeader(): boolean {
    return this.leading && this.clock() < this.validUntil;
  }

  status(): { leader: boolean; holder?: string; token: number } {
    return { leader: this.isLeader(), ...(this.holder && { holder: this.holder }), token: this.token };
  }

  /** Campaign every TTL/3 (tick() campaigns once, for tests). */
  start() {
    if (this.timer || this.stopped) return;
    const every = Math.max(250, Math.floor(this.ttlMs / 3));
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref?.();
    this.watchdog = setInterval(() => this.check(), Math.max(100, Math.min(1_000, Math.floor(this.ttlMs / 10))));
    this.watchdog.unref?.();
    void this.tick();
  }

  /** One campaign: take the key if free, renew it if ours. */
  async tick(): Promise<Leadership | undefined> {
    if (this.ticking || this.stopped) return undefined;
    this.ticking = true;
    const sentAt = this.clock();
    try {
      const result = await this.coordinator.campaign(this.id, this.ttlMs);
      this.holder = result.holder;
      if (result.mine) {
        // Counted from when the renewal was sent: the key lives at least that long.
        this.validUntil = sentAt + this.ttlMs - Math.max(500, Math.floor(this.ttlMs / 5));
        if (!this.leading || this.token !== result.token) {
          this.leading = true;
          this.token = result.token;
          this.elections++;
          await this.hooks.onElected?.(result.token);
        }
      } else if (this.leading) {
        await this.demote(`${result.holder ?? 'another instance'} leads now`);
      }
      return result;
    } catch {
      this.check();
      return undefined;
    } finally {
      this.ticking = false;
    }
  }

  /** Step down once the lease may have expired (renewals failing or too slow). */
  private check() {
    if (this.leading && this.clock() >= this.validUntil) void this.demote('the leadership lease could not be renewed in time');
  }

  private async demote(reason: string) {
    if (!this.leading) return;
    this.leading = false;
    this.validUntil = 0;
    await this.hooks.onDemoted?.(reason);
  }

  /** Stop campaigning; a leader resigns, so another main takes over at once. */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.watchdog);
    const wasLeading = this.leading;
    await this.demote('stopping');
    if (wasLeading) await this.coordinator.resign(this.id).catch(() => {});
  }
}
