function parseTable(output, headerPattern, parseRow) {
  const lines = dataLines(output);
  const header = lines.findIndex((line) => headerPattern.test(line));
  if (header === -1) return Object.freeze([]);
  return Object.freeze(lines.slice(header + 1).map(parseRow));
}

function parseInteger(value, fallback = null) {
  return Number.parseInt(value, 10) || fallback;
}

export function dataLines(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^[-\s]+$/.test(line));
}

export function parseFonts(output) {
  return parseTable(output, /^name\s+type\s+encoding/i, (line) => {
    const columns = line.trim().split(/\s{2,}/);
    return Object.freeze({
      name: columns[0] || 'Unknown', type: columns[1] || 'Unknown',
      encoding: columns[2] || 'Unknown', embedded: columns[3] || 'unknown',
      subset: columns[4] || 'unknown', unicode: columns[5] || 'unknown',
    });
  });
}

export function parseImages(output) {
  return parseTable(output, /^page\s+num\s+type/i, (line) => {
    const columns = line.trim().split(/\s+/);
    return Object.freeze({
      page: parseInteger(columns[0]), number: parseInteger(columns[1]),
      type: columns[2] || 'unknown', width: parseInteger(columns[3]),
      height: parseInteger(columns[4]), color: columns[5] || 'unknown',
      bitsPerComponent: parseInteger(columns[7]), encoding: columns[8] || 'unknown',
      objectId: parseInteger(columns[10]), generation: parseInteger(columns[11], 0),
      xPpi: Number.parseFloat(columns[12]) || null,
      yPpi: Number.parseFloat(columns[13]) || null,
    });
  });
}

export function parseAttachments(output) {
  const attachments = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s*:\s*(.+?)\s*$/);
    if (match) {
      attachments.push(Object.freeze({
        number: Number.parseInt(match[1], 10), name: match[2],
      }));
    }
  }
  return Object.freeze(attachments);
}
