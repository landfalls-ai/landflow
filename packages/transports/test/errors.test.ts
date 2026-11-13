/**
 * Messaging errors carry a literal `name` per class: the host's production bundle minifies class names, so a name taken
 * from `new.target.name` would differ per build (and with it the log's `exception.type` and the exception fingerprint).
 */
import { describe, expect, it } from 'vitest';
import { CancelledError, ClaimUnavailableError, ConnectionLostError, ManifestMismatchError, RemoteError, TimeoutError, UndeliverableError, UsageError } from '../src/errors';

describe('messaging error names', () => {
  it('names each class with a literal', () => {
    expect(new UndeliverableError('x', 'unroutable').name).toBe('UndeliverableError');
    expect(new TimeoutError('x', 1).name).toBe('TimeoutError');
    expect(new CancelledError().name).toBe('CancelledError');
    expect(new ConnectionLostError().name).toBe('ConnectionLostError');
    expect(new RemoteError('x', 'internal').name).toBe('RemoteError');
    expect(new ClaimUnavailableError('x', 'request').name).toBe('ClaimUnavailableError');
    expect(new ManifestMismatchError('a', 'b')).toMatchObject({ name: 'ManifestMismatchError', code: 'manifest_mismatch', knowledge: 'delivered' });
    expect(new UsageError('x').name).toBe('UsageError');
  });
});
