const FORMULA_PREFIX = /^(?:[\t\r\n]|\s*[=+\-@])/u;

export function spreadsheetSafeCsvText(value) {
  const text = String(value ?? '');
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

export function spreadsheetSafeCsvCell(value) {
  const inert = spreadsheetSafeCsvText(value);
  return `"${inert.replaceAll('"', '""')}"`;
}
