import assert from 'node:assert/strict';
import { makeXrefStreamPdf } from './pdf-xref-stream-fixture.js';

export const ref = (object, generation = 0) => (
  Object.freeze({ type: 'ref', object, generation })
);
export const name = (value) => Object.freeze({ type: 'name', value });
export const array = (values) => (
  Object.freeze({ type: 'array', values: Object.freeze(values) })
);
export const dict = (entries) => (
  Object.freeze({ type: 'dict', entries: new Map(entries) })
);

export function classicFixture({
  targetGeneration = 0,
  objectThree = '<< /Kind /Target >>',
  objectFour = `<< /Target 3 ${targetGeneration} R >>`,
} = {}) {
  const header = '%PDF-1.7\n';
  const bodies = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n`,
    `3 ${targetGeneration} obj\n${objectThree}\nendobj\n`,
    `4 0 obj\n${objectFour}\nendobj\n`,
  ];
  const offsets = [];
  let offset = Buffer.byteLength(header, 'latin1');
  for (const body of bodies) {
    offsets.push(offset);
    offset += Buffer.byteLength(body, 'latin1');
  }
  const rows = [
    '0000000000 65535 f ',
    `${String(offsets[0]).padStart(10, '0')} 00000 n `,
    `${String(offsets[1]).padStart(10, '0')} 00000 n `,
    `${String(offsets[2]).padStart(10, '0')} ${String(targetGeneration).padStart(5, '0')} n `,
    `${String(offsets[3]).padStart(10, '0')} 00000 n `,
  ];
  return Buffer.from(
    `${header}${bodies.join('')}xref\n0 5\n${rows.join('\n')}\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    'latin1',
  );
}

export function freeListFixture({ loop = false } = {}) {
  const header = '%PDF-1.7\n';
  const catalog = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const target = '3 0 obj\n<< /Kind /Target >>\nendobj\n';
  const catalogOffset = Buffer.byteLength(header, 'latin1');
  const targetOffset = catalogOffset + Buffer.byteLength(catalog, 'latin1');
  const xrefOffset = targetOffset + Buffer.byteLength(target, 'latin1');
  return Buffer.from(`${header}${catalog}${target}xref\n0 4\n0000000002 65535 f \n${String(catalogOffset).padStart(10, '0')} 00000 n \n${loop ? '0000000002' : '0000000000'} 00000 f \n${String(targetOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
}

export function validXrefStreamSource() {
  const source = makeXrefStreamPdf({ filtered: false });
  const marker = Buffer.from('\nstream\n', 'latin1');
  const payloadStart = source.lastIndexOf(marker) + marker.length;
  assert.ok(payloadStart >= marker.length);
  const result = Buffer.from(source);
  result.writeUInt32BE(3, payloadStart + 1);
  return result;
}

export function orphanedPermanentFreeFixture() {
  const header = '%PDF-1.7\n';
  const catalog = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const target = '3 0 obj\n<< /Kind /Target >>\nendobj\n';
  const survivor = '4 0 obj\n<< /Kind /Survivor >>\nendobj\n';
  const catalogOffset = Buffer.byteLength(header, 'latin1');
  const targetOffset = catalogOffset + Buffer.byteLength(catalog, 'latin1');
  const survivorOffset = targetOffset + Buffer.byteLength(target, 'latin1');
  const xrefOffset = survivorOffset + Buffer.byteLength(survivor, 'latin1');
  return Buffer.from(`${header}${catalog}${target}${survivor}xref\n0 5\n0000000000 65535 f \n${String(catalogOffset).padStart(10, '0')} 00000 n \n0000000000 65535 f \n${String(targetOffset).padStart(10, '0')} 00000 n \n${String(survivorOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
}

export function deletionRequest(source, structure, deletions, overrides = {}) {
  return {
    sourceBytes: source,
    sourceStructure: structure,
    deletions,
    updates: [],
    additions: [],
    info: { kind: 'preserve' },
    changingId: null,
    ...overrides,
  };
}

export function mutateTargetBody(source) {
  const before = Buffer.from('/Kind /Target', 'latin1');
  const offset = source.indexOf(before);
  assert.ok(offset >= 0);
  source.set(Buffer.from('/Kind /OmegaX', 'latin1'), offset);
}
