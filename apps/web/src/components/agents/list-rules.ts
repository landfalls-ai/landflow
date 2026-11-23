/** Rules for the Agents list (docs/agents.md#the-roster): when the persona strip shows and which filter chips appear. */

/** The persona strip only helps someone with no agents yet; with agents the list comes first. */
export function showPersonaStrip(agents: readonly unknown[] | undefined): boolean {
  return Boolean(agents) && agents!.length === 0;
}

/** The filters worth showing: every one with agents behind it, "All" always, and the active one so it can be cleared. */
export function visibleFilters<K extends string>(counts: ReadonlyArray<readonly [K, number]>, active?: K): K[] {
  const shown = counts.filter(([key, n], i) => i === 0 || n > 0 || key === active).map(([key]) => key);
  // Only "All" left: there is nothing to choose between.
  return shown.length > 1 ? shown : [];
}
