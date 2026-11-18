/** The credentials page's usage line: workflows with a node that uses the credential, and agents with a tool or model that does. */
export function credentialUsageLine(usedBy: ReadonlyArray<unknown>, usedByAgents: ReadonlyArray<unknown> = []): string {
  const parts = [usedBy.length && `${usedBy.length} workflow${usedBy.length === 1 ? '' : 's'}`, usedByAgents.length && `${usedByAgents.length} agent${usedByAgents.length === 1 ? '' : 's'}`].filter(Boolean);
  return parts.length ? `Used by ${parts.join(' and ')}` : 'Not used yet';
}
