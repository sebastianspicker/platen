/**
 * Shared PDF object serialization for specialist embed builders.
 */
import { createHash } from 'node:crypto';

export function pdfLiteral(text) {
  return `(${String(text).replace(/[\\()]/g, (ch) => `\\${ch}`)})`;
}

export function pdfHexString(bytes) {
  return `<${Buffer.from(bytes).toString('hex')}>`;
}

export function pdfEscapeName(name) {
  return `/${String(name).replace(/[^!-$&'*-.0-;=?-Z\\^-z|~]/g, (ch) => `#${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;
}

function writeObjects(parts, objects) {
  const offsets = new Map();
  let offset = Buffer.byteLength(parts[0], 'latin1');
  for (const [id, body] of objects) {
    offsets.set(id, offset);
    const chunk = `${id} 0 obj\n${body}\nendobj\n`;
    parts.push(chunk);
    offset += Buffer.byteLength(chunk, 'latin1');
  }
  return { offsets, offset };
}

export function finalizeSpecialistPdf(objects, catalogId, nextId) {
  const parts = ['%PDF-1.7\n%âãÏÓ\n'];
  const sorted = [...objects.entries()].sort((a, b) => a[0] - b[0]);
  const { offsets, offset } = writeObjects(parts, sorted);
  const xrefStart = offset;
  const size = nextId;
  const xrefLines = [`xref\n0 ${size}\n`, '0000000000 65535 f \n'];
  for (let id = 1; id < size; id += 1) {
    xrefLines.push(`${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  parts.push(Buffer.from(xrefLines.join(''), 'latin1'));
  const idBytes = createHash('sha256')
    .update(Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1')))))
    .digest()
    .subarray(0, 16);
  parts.push(Buffer.from(
    `trailer\n<< /Size ${size} /Root ${catalogId} 0 R /ID [${pdfHexString(idBytes)} ${pdfHexString(idBytes)}] >>\nstartxref\n${xrefStart}\n%%EOF\n`,
    'latin1',
  ));
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))));
}

export function allocIds() {
  let nextId = 1;
  return {
    alloc: () => nextId++,
    get nextId() { return nextId; },
  };
}
