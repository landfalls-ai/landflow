/**
 * CSV for Data Tables import and export (RFC 4180): quoted fields with "" for
 * a quote, commas and line breaks inside quotes, CRLF or LF, an optional BOM.
 * The delimiter of an import is detected from its header line (comma,
 * semicolon or tab).
 */

/** Pick the delimiter that splits the first line into the most fields (outside quotes). */
function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && char in counts) counts[char]++;
  }
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return count > 0 ? best : ',';
}

/** Rows of fields. Blank lines are dropped. */
export function parseCsv(input: string, delimiter?: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const separator = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    field = '';
  };
  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += char;
      i++;
      continue;
    }
    if (char === '"' && field === '') quoted = true;
    else if (char === separator) {
      row.push(field);
      field = '';
    } else if (char === '\r' || char === '\n') {
      endRow();
      if (char === '\r' && text[i + 1] === '\n') i++;
    } else field += char;
    i++;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

function escapeField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV text (CRLF line ends, as RFC 4180 says) from rows of values; null is an empty field. */
export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(escapeField).join(',')).join('\r\n') + (rows.length ? '\r\n' : '');
}
