import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyClosedClassicPdfOutput } from '../scripts/host/pdf-classic-closed-output.mjs';

function classicPdf({ extraObject = '', root = '1 0 R', previous = '', residue = '' } = {}) {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>\nendobj\n',
    ...(extraObject ? [extraObject] : []),
  ];
  let body = '%PDF-1.7\n%\xFF\xFF\xFF\xFF\n'; const offsets = [0];
  for (const object of objects) { offsets.push(Buffer.byteLength(body, 'latin1')); body += object; }
  body += residue;
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${root}${previous} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

test('closed classic output accepts exactly one fully reachable classic revision', () => {
  assert.deepEqual(verifyClosedClassicPdfOutput(classicPdf()), {
    revisionCount: 1, reachableObjectCount: 3, parsedObjectCount: 3, closed: true,
  });
});

test('closed classic output rejects prior revisions, dangling references, old objects, and non-whitespace residue', () => {
  for (const bytes of [
    classicPdf({ previous: ' /Prev 1' }),
    classicPdf({ root: '9 0 R' }),
    classicPdf({ extraObject: '4 0 obj\n<< /Type /Example >>\nendobj\n' }),
    classicPdf({ residue: 'old private bytes\n' }),
  ]) assert.throws(() => verifyClosedClassicPdfOutput(bytes), { code: 'INVALID_CLOSED_CLASSIC_PDF_OUTPUT' });
});

test('closed classic output rejects stream objects with indirect lengths and object streams', () => {
  const indirectLength = classicPdf({
    extraObject: '4 0 obj\n<< /Length 5 0 R >>\nstream\nabc\nendstream\nendobj\n5 0 obj\n3\nendobj\n',
  });
  const objectStream = classicPdf({
    extraObject: '4 0 obj\n<< /Type /ObjStm /Length 0 >>\nstream\nendstream\nendobj\n',
  });
  for (const bytes of [indirectLength, objectStream]) assert.throws(() => verifyClosedClassicPdfOutput(bytes), { code: 'INVALID_CLOSED_CLASSIC_PDF_OUTPUT' });
});
