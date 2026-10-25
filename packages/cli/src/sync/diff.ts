/**
 * Line diffs for `sync diff`: Myers' O(ND) algorithm over the lines between the common prefix and suffix, printed
 * as a unified diff (`--- a/path`, `+++ b/path`, `@@ -l,n +l,n @@`, three lines of context) that `git apply` and
 * `patch` read. The same inputs always give the same output.
 */

export interface DiffOp {
  type: ' ' | '-' | '+';
  line: string;
}

/** Past this many edits the diff gives up on finding the shortest script and replaces the middle wholesale. */
const MAX_EDITS = 4000;

const lines = (text: string) => {
  const out = text.split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
};

/** The edit script turning `a` into `b`. */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const same = (line: string): DiffOp => ({ type: ' ', line });
  return [...a.slice(0, start).map(same), ...myers(a.slice(start, endA), b.slice(start, endB)), ...a.slice(endA).map(same)];
}

function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const del = (line: string): DiffOp => ({ type: '-', line });
  const ins = (line: string): DiffOp => ({ type: '+', line });
  if (!n || !m) return [...a.map(del), ...b.map(ins)];
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] = v over k ∈ [-(d-1), d-1] before step d, for walking back.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d++) {
    trace.push(d === 0 ? new Int32Array(0) : v.slice(offset - (d - 1), offset + d));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return [...a.map(del), ...b.map(ins)];
}

function backtrack(trace: Int32Array[], a: string[], b: string[], d: number): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let step = d; step > 0; step--) {
    const v = trace[step];
    const at = (k: number) => v[k + step - 1];
    const k = x - y;
    const prevK = k === -step || (k !== step && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ type: ' ', line: a[x] });
    }
    if (x === prevX) ops.push({ type: '+', line: b[--y] });
    else ops.push({ type: '-', line: a[--x] });
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ type: ' ', line: a[x] });
  }
  return ops.reverse();
}

/**
 * A unified diff from `before` (the instance, `a/`) to `after` (the local file, `b/`); undefined for a side that has
 * no file (`/dev/null`). '' when they're equal.
 */
export function unifiedDiff(path: string, before: string | undefined, after: string | undefined, context = 3): string {
  const ops = diffLines(before === undefined ? [] : lines(before), after === undefined ? [] : lines(after));
  const changed = ops.flatMap((op, i) => (op.type === ' ' ? [] : [i]));
  if (!changed.length) return '';
  // Line numbers before each op, on each side.
  const aAt: number[] = [];
  const bAt: number[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    aAt.push(ai);
    bAt.push(bi);
    if (op.type !== '+') ai++;
    if (op.type !== '-') bi++;
  }
  const out = [`--- ${before === undefined ? '/dev/null' : `a/${path}`}`, `+++ ${after === undefined ? '/dev/null' : `b/${path}`}`];
  for (let i = 0; i < changed.length; ) {
    const from = Math.max(0, changed[i] - context);
    let last = changed[i];
    while (i < changed.length && changed[i] <= last + 2 * context) last = changed[i++];
    const to = Math.min(ops.length - 1, last + context);
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((op) => op.type !== '+').length;
    const newCount = slice.filter((op) => op.type !== '-').length;
    out.push(`@@ -${oldCount ? aAt[from] + 1 : aAt[from]},${oldCount} +${newCount ? bAt[from] + 1 : bAt[from]},${newCount} @@`);
    out.push(...slice.map((op) => `${op.type}${op.line}`));
  }
  return `${out.join('\n')}\n`;
}
