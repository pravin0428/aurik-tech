'use strict';

const { parseCsv } = require('../../src/util/csv');

describe('csv parser', () => {
  test('parses headers and rows into objects', () => {
    const { headers, rows } = parseCsv('a,b,c\n1,2,3\n4,5,6\n');
    expect(headers).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  test('handles quoted fields with commas, quotes, and empty values', () => {
    const text = 'id,note,flag\n1,"Belt wear; still ok","a,b"\n2,"",x\n';
    const { rows } = parseCsv(text);
    expect(rows[0]).toEqual({ id: '1', note: 'Belt wear; still ok', flag: 'a,b' });
    expect(rows[1]).toEqual({ id: '2', note: '', flag: 'x' });
  });

  test('handles escaped double-quotes', () => {
    const { rows } = parseCsv('id,note\n1,"He said ""hi"""\n');
    expect(rows[0].note).toBe('He said "hi"');
  });

  test('handles CRLF and a trailing newline', () => {
    const { rows } = parseCsv('a,b\r\n1,2\r\n');
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });

  test('strips a UTF-8 BOM', () => {
    const { headers } = parseCsv('\uFEFFa,b\n1,2\n');
    expect(headers).toEqual(['a', 'b']);
  });

  test('empty input yields no headers/rows', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });
});
