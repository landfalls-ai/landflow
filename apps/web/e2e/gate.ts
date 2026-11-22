/**
 * The browser tier is opt-in: `LANDFLOW_INTEGRATION` must name `browser` (it is a comma-separated list, like the other
 * integration flags in docs/development.md). `pnpm test` and the host's vitest run never reach it.
 */
export function browserTierEnabled(flag: string | undefined = process.env.LANDFLOW_INTEGRATION): boolean {
  return (flag ?? '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .includes('browser');
}

/** Throws unless the flag names `browser`; the config calls it so `playwright test` without the flag stops at once. */
export function requireBrowserTier(flag: string | undefined = process.env.LANDFLOW_INTEGRATION): void {
  if (!browserTierEnabled(flag)) throw new Error('The browser tier is opt-in: set LANDFLOW_INTEGRATION=browser (for example `LANDFLOW_INTEGRATION=browser pnpm test:browser`).');
}
