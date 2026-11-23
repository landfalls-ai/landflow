/**
 * The line a design says when it kept a tool the fix session added (`keep`, AG24): one wording for the design route, the
 * architect's `reviseDraft` and the session's reading of it (`showAgentFix`). `lib/shared/fix-autonomy.ts` is a contract copy and
 * is not edited for it.
 */
export const keptToolLine = (name: string): string => `Kept “${name}”: this session added it`;

/** The tool's name from a `keptToolLine`, or undefined for any other line. */
export const keptToolOf = (line: string): string | undefined => /^Kept “(.+)”: this session added it$/.exec(line)?.[1];
