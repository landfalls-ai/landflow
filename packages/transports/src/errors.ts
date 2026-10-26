/**
 * Typed errors of `MessagingClient.call()`. The selector acts on `knowledge`: a call moves to another transport only
 * when it provably was not delivered (`not-delivered`); otherwise the error surfaces, so nothing runs twice
 * (docs/transports.md "Choosing a transport per call", rule 7).
 */
import type { RemoteErrorCode } from './envelope';

/** What is known about whether the plugin got the request. */
export type DeliveryKnowledge = 'not-delivered' | 'maybe-delivered' | 'delivered';

export abstract class MessagingError extends Error {
  abstract readonly knowledge: DeliveryKnowledge;
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type UndeliverableReason =
  /** The driver reported that nobody can take the event (NATS no responders, RabbitMQ `mandatory`). */
  | 'unroutable'
  /** Every instance the registry channel had announced has stopped heartbeating, or the channel shows zero consumers. */
  | 'no_consumers'
  /** The connection was not open (connect failed, or the client is closed) before anything was published. */
  | 'not_connected'
  /** The encoded event is bigger than the driver's `maxMessageBytes` (or the header budget). */
  | 'too_large'
  /** The call was aborted before it was published. */
  | 'aborted'
  /** The body is too big for the broker and the claim store could not take it (nothing was published). */
  | 'claim_failed';

/** Provably not delivered: safe to send over another transport. */
export class UndeliverableError extends MessagingError {
  readonly knowledge = 'not-delivered' as const;
  constructor(
    message: string,
    readonly reason: UndeliverableReason,
  ) {
    super(message, reason);
  }
}

/** The deadline passed without a reply. The plugin may have run the call ("the plugin went away; the call may have run"). */
export class TimeoutError extends MessagingError {
  readonly knowledge = 'maybe-delivered' as const;
  constructor(
    message: string,
    readonly deadline: number,
  ) {
    super(message, 'deadline');
  }
}

/** The caller aborted after the request was published; a cancel event went out, but the plugin may have finished first. */
export class CancelledError extends MessagingError {
  readonly knowledge = 'maybe-delivered' as const;
  constructor(message = 'the call was cancelled') {
    super(message, 'cancelled');
  }
}

/** The connection (and with it the reply inbox) was lost while the call was in flight. */
export class ConnectionLostError extends MessagingError {
  readonly knowledge = 'maybe-delivered' as const;
  constructor(message = 'connection lost; the call may have run') {
    super(message, 'connection_lost');
  }
}

/** The plugin answered with an error code in `lferror` (the body is `{ error, … }`). Delivered, so never retried blindly. */
export class RemoteError extends MessagingError {
  readonly knowledge = 'delivered' as const;
  constructor(
    message: string,
    readonly remoteCode: RemoteErrorCode,
    readonly details?: unknown,
  ) {
    super(message, remoteCode);
  }
}

/**
 * A body travelling through the claim store could not be read: expired or deleted, the store is down, or size/digest do
 * not match. In the request direction the plugin refused the call before running it (`not-delivered`, so the selector may
 * use another transport); in the response direction the plugin has already run it (`delivered`).
 */
export class ClaimUnavailableError extends MessagingError {
  readonly knowledge: DeliveryKnowledge;
  constructor(
    message: string,
    readonly direction: 'request' | 'response',
  ) {
    super(message, 'claim_unavailable');
    this.knowledge = direction === 'request' ? 'not-delivered' : 'delivered';
  }
}

/** The plugin's manifest differs from the one the host knows: pull the manifest again, then retry. */
export class ManifestMismatchError extends RemoteError {
  constructor(
    readonly expected: string | undefined,
    readonly actual: string | undefined,
  ) {
    super(`manifest mismatch: the host knows ${expected ?? 'none'}, the plugin runs ${actual ?? 'unknown'}`, 'manifest_mismatch');
  }
}

/** The caller's own mistake (bad arguments, client not started). Nothing was sent. */
export class UsageError extends MessagingError {
  readonly knowledge = 'not-delivered' as const;
  constructor(message: string) {
    super(message, 'usage');
  }
}

export const isMessagingError = (error: unknown): error is MessagingError => error instanceof MessagingError;
/** `true` when the selector may send the same call over another transport. */
export const isProvablyUndelivered = (error: unknown): boolean => isMessagingError(error) && error.knowledge === 'not-delivered';
