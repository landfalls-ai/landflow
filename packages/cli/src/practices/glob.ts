/**
 * Globs of a practice's `paths` and checks: the one implementation lives in `@landflow/protocol/practice-checks` (a subpath, so the CLI does not pull in the protocol's zod),
 * shared with the Check Practices step; their tests share one table (docs/practices.md#globs).
 */
export { practiceGlob, matchesPracticeGlob } from '@landflow/protocol/practice-checks';
