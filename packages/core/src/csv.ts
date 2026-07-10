/**
 * Dependency-free CSV helpers (RFC-4180 style: quoted fields, doubled
 * quotes, embedded commas/newlines, \n or \r\n row separators).
 */

/** Parse CSV text into raw rows of string fields. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) {
    throw new Error('parseCsvRows: unterminated quoted field');
  }
  if (field !== '' || row.length > 0) {
    pushRow();
  }
  return rows;
}

/**
 * Parse CSV text whose first row is a header into records keyed by header.
 * Missing trailing fields become ''.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const [header, ...rest] = rows;
  return rest.map((r) =>
    Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])),
  );
}

const NEEDS_QUOTING = /[",\r\n]/;

function escapeField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return NEEDS_QUOTING.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Serialize raw rows (arrays of cells) to CSV text with a trailing newline. */
export function serializeCsvRows(rows: readonly (readonly unknown[])[]): string {
  if (rows.length === 0) return '';
  return rows.map((r) => r.map(escapeField).join(',')).join('\n') + '\n';
}

/**
 * Serialize records to CSV with a header row. Column order comes from
 * `columns` when given, otherwise from the keys of the first record.
 */
export function serializeCsv(
  records: readonly Record<string, unknown>[],
  columns?: readonly string[],
): string {
  const cols = columns ?? (records.length > 0 ? Object.keys(records[0]) : []);
  if (cols.length === 0) return '';
  return serializeCsvRows([
    cols,
    ...records.map((rec) => cols.map((c) => rec[c])),
  ]);
}
