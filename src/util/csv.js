'use strict';

/**
 * Minimal RFC4180-style CSV parser (no dependency). Supports:
 *   * quoted fields with embedded commas, quotes (""), and newlines
 *   * CRLF or LF line endings
 *   * a UTF-8 BOM at the start of the file
 *   * a trailing newline
 *
 * Values are returned as strings; empty fields become ''. Callers coerce types.
 * This exists so the reference/seed CSVs can be loaded without adding a
 * dependency for a one-off import.
 */

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseCsv(text) {
  const input = stripBom(String(text));
  const rows = [];
  let field = '';
  let row = [];
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

  while (i < input.length) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
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

    if (ch === '"') {
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
      if (input[i + 1] === '\n') i += 1;
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

  // Final field/row if the file did not end with a newline.
  if (field.length > 0 || row.length > 0) pushRow();

  // Drop trailing blank rows (a file ending in "\n" yields one).
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === '')) {
    rows.pop();
  }

  if (rows.length === 0) return { headers: [], rows: [] };

  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((cells) => {
    const obj = {};
    for (let c = 0; c < headers.length; c += 1) {
      obj[headers[c]] = cells[c] !== undefined ? cells[c] : '';
    }
    return obj;
  });

  return { headers, rows: records };
}

module.exports = { parseCsv };
