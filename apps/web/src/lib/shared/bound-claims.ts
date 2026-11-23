/**
 * The text format of the JWT Auth credential's Bound Claims: one `claim: pattern` per line, `#` comments and blank lines
 * ignored. Pure and browser-safe: the credential dialog's claims editor and the server's checks (lib/server/jwt-claims.ts)
 * read it with this one parser, so the editor can never write what the server would not read.
 */

export interface BoundClaim {
  claim: string;
  pattern: string;
}

const LINE = /^([^\s:]+)\s*:\s*(\S.*)$/;

/** Reads the credential's text; `problems` names every line that is not `claim: pattern`. */
export function parseBoundClaims(text: string): { claims: BoundClaim[]; problems: string[] } {
  const claims: BoundClaim[] = [];
  const problems: string[] = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const match = LINE.exec(line);
      if (match) claims.push({ claim: match[1], pattern: match[2].trim() });
      else problems.push(`line ${index + 1}: expected “claim: pattern”`);
    });
  return { claims, problems };
}

/** The text for a list of claims: the inverse of `parseBoundClaims` (comments are not kept). */
export function formatBoundClaims(claims: BoundClaim[]): string {
  return claims.map(({ claim, pattern }) => `${claim}: ${pattern}`).join('\n');
}
