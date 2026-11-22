'use client';
/**
 * The JWT Auth parts of the credential dialog: "GitHub Actions" and "GitLab CI" presets (they fill the issuer, the JWKS
 * URL, the algorithm and Single Use, and open a row for the claim that pins the repository or project), and a rows
 * editor for Bound Claims. The editor reads and writes the same `boundClaims` text the field below it shows, through the
 * shared parser (lib/shared/bound-claims.ts), so both views always agree; it changes only the lines it shows, so
 * comments and unreadable lines in the text survive an edit; the parser's problems are shown under it.
 */
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseBoundClaims, type BoundClaim } from '@/lib/shared/bound-claims';
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
    hint: 'Pin the repository (and, if you like, ref or environment): any GitHub repository can mint a token for your audience, so a pin is required. The job must request the audience set here: core.getIDToken(\'landflow\') in actions/github-script, or the audience parameter of the OIDC token request URL.',
    values: { keyType: 'jwks', jwksUrl: 'https://token.actions.githubusercontent.com/.well-known/jwks', issuer: 'https://token.actions.githubusercontent.com', algorithm: 'RS256', singleUse: true, audience: 'landflow' },
  },
  {
    id: 'gitlab',
    name: 'GitLab CI',
    claim: 'project_path',
    placeholder: 'my-group/my-project',
    hint: 'Pin the project path (and, if you like, ref_protected or environment): any GitLab.com project can mint a token for your audience, so a pin is required. The job must request the audience set here: id_tokens: with aud: landflow in .gitlab-ci.yml.',
    values: { keyType: 'jwks', jwksUrl: 'https://gitlab.com/oauth/discovery/keys', issuer: 'https://gitlab.com', algorithm: 'RS256', singleUse: true, audience: 'landflow' },
  },
];

/** The credential's values with the preset's fields filled in; bound claims already written are kept. */
export function applyJwtPreset(values: Record<string, unknown>, preset: JwtPreset): Record<string, unknown> {
  return { ...values, ...preset.values, audience: String(values.audience ?? '').trim() || preset.values.audience, boundClaims: String(values.boundClaims ?? '') };
}

/** A row of the editor; `line` is its line in the field's text (none for a row not written yet). */
export interface ClaimRow extends BoundClaim {
  line?: number;
}

/** The editor's rows for the field's text (a comment or a line that is not `claim: pattern` has no row: it stays as it is). */
export function claimRowsFromText(text: string): ClaimRow[] {
  const rows: ClaimRow[] = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, line) => {
      const parsed = parseBoundClaims(raw).claims[0];
      if (parsed) rows.push({ ...parsed, line });
    });
  return rows;
}

/**
 * The field's text after the rows changed, spliced into `text` so comments and unreadable lines stay where they are: a
 * finished row rewrites its own line, a removed row takes its line, a row emptied mid-edit keeps its last line, a new
 * finished row is appended and a new unfinished one is not written yet. Returns the rows with their new line numbers.
 */
export function spliceClaimRows(text: string, rows: ClaimRow[]): { text: string; rows: ClaimRow[] } {
  const done = (row: ClaimRow) => row.claim.trim() !== '' && row.pattern.trim() !== '';
  const lineOf = (row: ClaimRow) => `${row.claim.trim()}: ${row.pattern.trim()}`;
  const original = String(text ?? '').split(/\r?\n/);
  const byLine = new Map(rows.filter((row) => row.line !== undefined).map((row) => [row.line, row]));
  const claimLines = new Set(claimRowsFromText(text).map((row) => row.line));
  const out: string[] = [];
  const next = new Map<ClaimRow, number>();
  original.forEach((raw, line) => {
    if (!claimLines.has(line)) return void out.push(raw);
    const row = byLine.get(line);
    if (!row) return; // removed
    next.set(row, out.length);
    out.push(done(row) ? lineOf(row) : raw);
  });
  for (const row of rows) {
    if (row.line !== undefined || !done(row)) continue;
    next.set(row, out.length);
    out.push(lineOf(row));
  }
  // A text that was only blank has no lines worth keeping.
  const written = out.length === 1 && out[0] === '' ? '' : out.join('\n');
  return { text: written, rows: rows.map((row) => ({ ...row, line: next.get(row) })) };
}

export function JwtAuthPresets({ values, onChange }: { values: Record<string, unknown>; onChange: (values: Record<string, unknown>) => void }) {
  const text = String(values.boundClaims ?? '');
  const [picked, setPicked] = useState<string>();
  // Unfinished rows live here; whenever the text changes from outside (the field below, a preset) the rows follow it.
  const [draft, setDraft] = useState<{ rows: ClaimRow[]; text: string }>();
  const rows = draft && draft.text === text ? draft.rows : claimRowsFromText(text);
  const preset = JWT_PRESETS.find((p) => p.id === picked);
  const problems = parseBoundClaims(text).problems;

  const write = (next: ClaimRow[]) => {
    const spliced = spliceClaimRows(text, next);
    setDraft({ rows: spliced.rows, text: spliced.text });
    onChange({ ...values, boundClaims: spliced.text });
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
                const existing = claimRowsFromText(String(filled.boundClaims));
                setDraft({ rows: existing.some((row) => row.claim === p.claim) ? existing : [...existing, { claim: p.claim, pattern: '' }], text: String(filled.boundClaims) });
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
