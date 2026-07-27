import { deflateSync } from 'node:zlib';

function asciiHex(bytes) { return Buffer.from(`${bytes.toString('hex')}>`, 'latin1'); }
function ascii85(bytes) {
  let output = '';
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const count = Math.min(4, bytes.length - offset); let value = 0;
    for (let index = 0; index < 4; index += 1) value = (value * 256) + (bytes[offset + index] ?? 0);
    const tuple = Array(5);
    for (let index = 4; index >= 0; index -= 1) { tuple[index] = String.fromCharCode((value % 85) + 33); value = Math.floor(value / 85); }
    output += tuple.join('').slice(0, count + 1);
  }
  return Buffer.from(`${output}~>`, 'latin1');
}
function paeth(left, up, upperLeft) { const value = left + up - upperLeft; const a = Math.abs(value - left); const b = Math.abs(value - up); const c = Math.abs(value - upperLeft); return a <= b && a <= c ? left : b <= c ? up : upperLeft; }
function predictorRows(bytes, columns, methods = []) { const rows = []; for (let offset = 0, row = 0; offset < bytes.length; offset += columns, row += 1) { const method = methods[row] ?? 0; const encoded = Buffer.alloc(columns); for (let column = 0; column < columns; column += 1) { const actual = bytes[offset + column]; const left = column ? bytes[offset + column - 1] : 0; const up = offset ? bytes[offset - columns + column] : 0; const upperLeft = offset && column ? bytes[offset - columns + column - 1] : 0; const base = method === 0 ? 0 : method === 1 ? left : method === 2 ? up : method === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft); encoded[column] = (actual - base) & 255; } rows.push(Buffer.concat([Buffer.from([method]), encoded])); } return Buffer.concat(rows); }
function runLength(bytes) { const chunks = []; for (let offset = 0; offset < bytes.length; offset += 128) { const count = Math.min(128, bytes.length - offset); chunks.push(Buffer.from([count - 1]), bytes.subarray(offset, offset + count)); } return Buffer.concat([...chunks, Buffer.from([128])]); }
function encodeFilters(bytes, filters, predictor = null) {
  let result = bytes;
  for (let index = filters.length - 1; index >= 0; index -= 1) {
    result = filters[index] === 'FlateDecode' ? deflateSync(predictor ? predictorRows(result, predictor.columns, predictor.methods) : result)
      : filters[index] === 'RunLengthDecode' ? runLength(result)
        : filters[index] === 'ASCIIHexDecode' ? asciiHex(result) : ascii85(result);
  }
  return result;
}
function filterDictionary(filters, predictor = null) {
  if (filters.length === 0) return '';
  const params = predictor ? `<< /Predictor ${predictor.declared ?? 15} /Columns ${predictor.columns} >>` : 'null';
  if (filters.length === 1) return ` /Filter /${filters[0]}${predictor ? ` /DecodeParms ${params}` : ''}`;
  return ` /Filter [${filters.map((filter) => `/${filter}`).join(' ')}] /DecodeParms [${filters.map((filter) => filter === 'FlateDecode' ? params : 'null').join(' ')}]`;
}

function row(type, field2, field3) {
  const bytes = Buffer.alloc(7);
  bytes[0] = type;
  bytes.writeUInt32BE(field2, 1);
  bytes.writeUInt16BE(field3, 5);
  return bytes;
}

export function makeXrefStreamPdf({
  objectTwoType = 1,
  filtered = true,
  explicitIndex = true,
  badSelf = false,
  catalogOffsetDelta = 0,
  xrefFilters = null,
  xrefPredictor = null,
  pageExtra = '',
  infoValue = '<< /Title (Old) >>',
} = {}) {
  const header = '%PDF-1.7\n';
  const catalog = '1 0 obj\n<< /Type /Catalog /Pages 4 0 R >>\nendobj\n';
  const info = `2 0 obj\n${infoValue}\nendobj\n`;
  const pages = '4 0 obj\n<< /Type /Pages /Count 1 /Kids [5 0 R] >>\nendobj\n';
  const page = `5 0 obj\n<< /Type /Page /Parent 4 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 6 0 R${pageExtra} >>\nendobj\n`;
  const contents = '6 0 obj\n<< /Length 5 >>\nstream\nBT ET\nendstream\nendobj\n';
  const catalogOffset = Buffer.byteLength(header, 'latin1');
  const infoOffset = catalogOffset + Buffer.byteLength(catalog, 'latin1');
  const pagesOffset = infoOffset + Buffer.byteLength(info, 'latin1');
  const pageOffset = pagesOffset + Buffer.byteLength(pages, 'latin1');
  const contentsOffset = pageOffset + Buffer.byteLength(page, 'latin1');
  const xrefOffset = contentsOffset + Buffer.byteLength(contents, 'latin1');
  const rows = Buffer.concat([
    row(0, 0, 65_535), row(1, catalogOffset + catalogOffsetDelta, 0), row(objectTwoType, infoOffset, 0), row(0, 0, 0),
    row(1, pagesOffset, 0), row(1, pageOffset, 0), row(1, contentsOffset, 0), row(1, badSelf ? xrefOffset - 1 : xrefOffset, 0),
  ]);
  const filters = xrefFilters ?? (filtered ? ['FlateDecode'] : []);
  const payload = encodeFilters(rows, filters, xrefPredictor);
  const index = explicitIndex ? ' /Index [0 8]' : '';
  const filter = filterDictionary(filters, xrefPredictor);
  const xref = `7 0 obj\n<< /Type /XRef /W [1 4 2]${index} /Size 8 /Root 1 0 R /Info 2 0 R${filter} /Length ${payload.length} >>\nstream\n`;
  return Buffer.concat([
    Buffer.from(`${header}${catalog}${info}${pages}${page}${contents}${xref}`, 'latin1'), payload,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'),
  ]);
}

export function makeWZeroXrefStreamSection({ xrefFilters = [] } = {}) {
  const header = '%PDF-1.7\n'; const offset = Buffer.byteLength(header, 'latin1');
  const rows = Buffer.alloc(6); rows.writeUInt32BE(offset, 0);
  const payload = encodeFilters(rows, xrefFilters);
  const object = `1 0 obj\n<< /Type /XRef /W [0 4 2] /Index [1 1] /Size 2 /Root 1 0 R${filterDictionary(xrefFilters)} /Length ${payload.length} >>\nstream\n`;
  return Buffer.concat([Buffer.from(`${header}${object}`, 'latin1'), payload,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${offset}\n%%EOF\n`, 'latin1')]);
}

export function makeObjectStreamPdf({ filtered = true, compressedCatalog = false, objectFilters = null, xrefFilters = null, objectPredictor = null, xrefPredictor = null, pageExtra = '', infoValue = '<< /Title (Old) >>' } = {}) {
  const header = '%PDF-1.7\n';
  const catalogMember = '<< /Type /Catalog /Pages 4 0 R >>';
  const infoMember = infoValue;
  const catalog = compressedCatalog
    ? '' : `1 0 obj\n${catalogMember}\nendobj\n`;
  const directory = compressedCatalog
    ? `1 0 2 ${Buffer.byteLength(catalogMember, 'latin1') + 1} ` : '2 0 ';
  const members = compressedCatalog
    ? `${catalogMember} ${infoMember}` : infoMember;
  const objectPayload = Buffer.from(`${directory}${members}`, 'latin1');
  const objectChain = objectFilters ?? (filtered ? ['FlateDecode'] : []);
  const effectiveObjectPredictor = objectPredictor ? { ...objectPredictor, columns: objectPredictor.columns ?? objectPayload.length } : null;
  const payload = encodeFilters(objectPayload, objectChain, effectiveObjectPredictor);
  const objectStream = `3 0 obj\n<< /Type /ObjStm /N ${compressedCatalog ? 2 : 1} /First ${Buffer.byteLength(directory, 'latin1')}${filterDictionary(objectChain, effectiveObjectPredictor)} /Length ${payload.length} >>\nstream\n`;
  const objectStreamTail = '\nendstream\nendobj\n';
  const pages = '4 0 obj\n<< /Type /Pages /Count 1 /Kids [5 0 R] >>\nendobj\n';
  const page = `5 0 obj\n<< /Type /Page /Parent 4 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 6 0 R${pageExtra} >>\nendobj\n`;
  const contents = '6 0 obj\n<< /Length 5 >>\nstream\nBT ET\nendstream\nendobj\n';
  const catalogOffset = Buffer.byteLength(header, 'latin1');
  const objectStreamOffset = catalogOffset + Buffer.byteLength(catalog, 'latin1');
  const pagesOffset = objectStreamOffset + Buffer.byteLength(objectStream, 'latin1') + payload.length + Buffer.byteLength(objectStreamTail, 'latin1');
  const pageOffset = pagesOffset + Buffer.byteLength(pages, 'latin1');
  const contentsOffset = pageOffset + Buffer.byteLength(page, 'latin1');
  const xrefOffset = contentsOffset + Buffer.byteLength(contents, 'latin1');
  const rows = Buffer.concat([
    row(0, 0, 65_535), compressedCatalog ? row(2, 3, 0) : row(1, catalogOffset, 0),
    row(2, 3, compressedCatalog ? 1 : 0), row(1, objectStreamOffset, 0),
    row(1, pagesOffset, 0), row(1, pageOffset, 0), row(1, contentsOffset, 0), row(1, xrefOffset, 0),
  ]);
  const xrefChain = xrefFilters ?? (filtered ? ['FlateDecode'] : []);
  const xrefPayload = encodeFilters(rows, xrefChain, xrefPredictor);
  const xref = `7 0 obj\n<< /Type /XRef /W [1 4 2] /Index [0 8] /Size 8 /Root 1 0 R /Info 2 0 R${filterDictionary(xrefChain, xrefPredictor)} /Length ${xrefPayload.length} >>\nstream\n`;
  return Buffer.concat([Buffer.from(`${header}${catalog}${objectStream}`, 'latin1'), payload,
    Buffer.from(`${objectStreamTail}${pages}${page}${contents}${xref}`, 'latin1'), xrefPayload,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1')]);
}
