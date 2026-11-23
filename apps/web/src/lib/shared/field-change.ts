/** One changed field of a per-field diff (components/ui/field-diff.tsx draws it; lib/shared/agent-diff.ts makes it). Plain type, no imports. */
export interface FieldChange {
  /** A stable key. */
  field: string;
  label: string;
  before?: string;
  after?: string;
  kind: 'changed' | 'added' | 'removed';
  /** Fold it; absent: a value over 120 characters or with a line break. */
  long?: boolean;
  /** The colour of the new value: good (green), bad (red), muted (grey); absent: the normal text colour. */
  tone?: 'good' | 'bad' | 'muted';
  /** A tooltip on the whole line, such as the full list a shortened value stands for. */
  title?: string;
}
