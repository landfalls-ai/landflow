'use client';
/**
 * The JWT Auth parts of the credential dialog: "GitHub Actions" and "GitLab CI" presets (they fill the issuer, the JWKS
 * URL, the algorithm and Single Use, and open a row for the claim that pins the repository or project), and a rows
 * editor for Bound Claims. The editor reads and writes the same `boundClaims` text the field below it shows, through the
 * shared parser (lib/shared/bound-claims.ts), so both views always agree; the parser's problems are shown under it.
 */
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatBoundClaims, parseBoundClaims, type BoundClaim } from '@/lib/shared/bound-claims';
import { Button } from '../ui/button';
import { FieldLabel, Input } from '../ui/inputs';

/** The credential type the dialog mounts these for. */
export const JWT_AUTH_CREDENTIAL = 'core.jwtAuth';

export interface JwtPreset {
  id: string;
  name: string;
  /** The claim that pins one repository or project: the row the editor opens. */
  claim: string;
  placeholder: string;
  hint: string;
  values: Record<string, unknown>;
}

export const JWT_PRESETS: readonly JwtPreset[] = [
  {
    id: 'github',
    name: 'GitHub Actions',
    claim: 'repository',
    placeholder: 'my-org/my-repo',
    hint: 'Pin the repository (and, if you like, ref or environment). Any GitHub repository can mint a token for your audience, so a pin is required.',
    values: { keyType: 'jwks', jwksUrl: 'https://token.actions.githubusercontent.com/.well-known/jwks', issuer: 'https://token.actions.githubusercontent.com', algorithm: 'RS256', singleUse: true },
  },
  {
    id: 'gitlab',
    name: 'GitLab CI',
    claim: 'project_path',
    placeholder: 'my-group/my-project',
    hint: 'Pin the project path (and, if you like, ref_protected or environment). Any GitLab.com project can mint a token for your audience, so a pin is required.',
    values: { keyType: 'jwks', jwksUrl: 'https://gitlab.com/oauth/discovery/keys', issuer: 'https://gitlab.com', algorithm: 'RS256', singleUse: true },
  },
];

/** The credential's values with the preset's fields filled in; bound claims already written are kept. */
export function applyJwtPreset(values: Record<string, unknown>, preset: JwtPreset): Record<string, unknown> {
  return { ...values, ...preset.values, boundClaims: String(values.boundClaims ?? '') };
}

/** The editor's rows for the field's text (a line that is not `claim: pattern` has no row: the field shows it). */
export const claimRowsFromText = (text: string): BoundClaim[] => parseBoundClaims(text).claims;

/** The text for the editor's rows; a row with no claim or no pattern yet is left out until it is finished. */
export const textFromClaimRows = (rows: BoundClaim[]): string => formatBoundClaims(rows.filter((row) => row.claim.trim() && row.pattern.trim()).map((row) => ({ claim: row.claim.trim(), pattern: row.pattern.trim() })));

export function JwtAuthPresets({ values, onChange }: { values: Record<string, unknown>; onChange: (values: Record<string, unknown>) => void }) {
  const text = String(values.boundClaims ?? '');
  const [picked, setPicked] = useState<string>();
  // Unfinished rows live here; whenever the text changes from outside (the field below, a preset) the rows follow it.
  const [draft, setDraft] = useState<{ rows: BoundClaim[]; text: string }>();
  const rows = draft && draft.text === text ? draft.rows : claimRowsFromText(text);
  const preset = JWT_PRESETS.find((p) => p.id === picked);
  const problems = parseBoundClaims(text).problems;

  const write = (next: BoundClaim[]) => {
    const nextText = textFromClaimRows(next);
    setDraft({ rows: next, text: nextText });
    onChange({ ...values, boundClaims: nextText });
  };

  return (
    <div className="space-y-3">
      <div>
        <FieldLabel>Fill in for</FieldLabel>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="CI provider presets">
          {JWT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setPicked(p.id);
                const filled = applyJwtPreset(values, p);
                const has = claimRowsFromText(String(filled.boundClaims)).some((row) => row.claim === p.claim);
                const nextRows = has ? claimRowsFromText(String(filled.boundClaims)) : [...claimRowsFromText(String(filled.boundClaims)), { claim: p.claim, pattern: '' }];
                setDraft({ rows: nextRows, text: String(filled.boundClaims) });
                onChange(filled);
              }}
              className={cn('h-7 rounded-full border px-3 text-[12px] transition-colors max-md:h-11', picked === p.id ? 'border-ac bg-acdim font-semibold text-t1' : 'border-hair text-t2 hover:border-ac hover:text-ac')}
            >
              {p.name}
            </button>
          ))}
        </div>
        {preset && <p className="mt-1.5 text-[12px] leading-snug text-t3 animate-fade-up">{preset.hint}</p>}
      </div>
      <div>
        <FieldLabel>Claims the token must carry</FieldLabel>
        <div className="space-y-1.5">
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input className="w-[34%] font-mono max-md:h-11" value={row.claim} placeholder="repository" aria-label="Claim" onChange={(e) => write(rows.map((r, i) => (i === index ? { ...r, claim: e.target.value } : r)))} />
              <Input
                className="min-w-0 flex-1 font-mono max-md:h-11"
                value={row.pattern}
                placeholder={row.claim === preset?.claim ? preset.placeholder : 'my-org/my-repo or refs/heads/*'}
                aria-label="Pattern"
                onChange={(e) => write(rows.map((r, i) => (i === index ? { ...r, pattern: e.target.value } : r)))}
              />
              <Button size="icon-sm" variant="ghost" aria-label="Remove claim" className="max-md:size-11" onClick={() => write(rows.filter((_, i) => i !== index))}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button size="sm" variant="ghost" className="mt-1.5 max-md:h-11" onClick={() => write([...rows, { claim: '', pattern: '' }])}>
          <Plus className="size-3.5" /> Add claim
        </Button>
        <p className="mt-1 text-[12px] text-t3">Every row must match. * matches within one segment (it stops at / and :).</p>
        {problems.length > 0 && <p className="mt-1 text-[12px] text-rd">{problems.join('; ')}</p>}
      </div>
    </div>
  );
}
