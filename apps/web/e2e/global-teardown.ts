/** After the specs: stop the hosts (and delete their data directories), and fail when `apps/web/.data` changed meanwhile. */
import { dataStamp } from './global-setup';

export default async function globalTeardown(): Promise<void> {
  const state = globalThis.__landflowE2E;
  await state?.prodHost?.stop();
  await state?.host?.stop();
  const after = dataStamp();
  if (state?.liveDataStamp !== undefined && after !== state.liveDataStamp) {
    throw new Error(`apps/web/.data changed during the browser tier (${state.liveDataStamp} -> ${after}): a scratch host used the live data directory`);
  }
}
