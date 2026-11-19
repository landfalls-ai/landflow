/**
 * The brain store (docs/features/notion-brain.md#how-it-is-built): import this, not `./port` or `./local`. Loading it
 * registers the local store; the port's functions are re-exported.
 */
import './local';

export { brainStoreFor, emitBrainChange, onBrainChange, setBackendResolver, setLocalBrainStore } from './port';
export { changeOrigin } from './origin';
