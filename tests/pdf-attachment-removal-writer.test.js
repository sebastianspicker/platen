import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectPdfAttachmentRemoval, writePdfAttachmentRemoval } from '../scripts/host/pdf-attachment-removal-writer.mjs';

const request = Object.freeze({ profile: 'local-document-attachment-removal-v1' });
function fixture({ shared = false, action = '', presentation = '', filter = '', length = 3, content = 'abc', pageMode = '', id = '', treeName = 'attachment.bin', fileName = treeName, annotationSubtype = '' } = {}) {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 5 0 R >>${pageMode} >>`,
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Contents 4 0 R${shared ? ' /X 6 0 R' : ''}${action}${presentation}${annotationSubtype ? ` /Annots [<< /Type /Annot /Subtype /${annotationSubtype} /Rect [0 0 10 10] >>]` : ''} >>`,
    '<< /Length 0 >>\nstream\n\nendstream',
    `<< /Names [(${treeName}) 6 0 R] >>`,
    `<< /Type /Filespec /F (${fileName}) /UF (${fileName}) /EF << /F 7 0 R >> >>`,
    `<< /Type /EmbeddedFile /Length ${length}${filter} >>\nstream\n${content}\nendstream`,
  ];
  let body = '%PDF-1.7\n'; const offsets = [];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(body, 'latin1')); body += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(body, 'latin1'); body += 'xref\n0 8\n0000000000 65535 f \n'; offsets.forEach((offset) => { body += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  return Buffer.from(`${body}trailer\n<< /Size 8 /Root 1 0 R${id} >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
}

test('removes one embedded-file tree while preserving ordinary page content streams', () => {
  const source = fixture({ pageMode: ' /PageMode /UseAttachments' }); const result = writePdfAttachmentRemoval(source, request);
  assert.equal(result.bytes.includes(Buffer.from('attachment.bin', 'latin1')), false);
  assert.equal(result.bytes.includes(Buffer.from('abc', 'latin1')), false);
  assert.equal(result.bytes.includes(Buffer.from('/UseAttachments', 'latin1')), false);
  assert.equal(result.proof.removedObjectCount, 3); assert.equal(result.proof.name, undefined); assert.equal(result.proof.content, undefined);
  assert.deepEqual(inspectPdfAttachmentRemoval(source, result.bytes, request, result), result.proof);
});

test('fails closed for shared, action, presentation, and malformed embedded-file inputs', () => {
  const hostile = [
    fixture({ shared: true }), fixture({ action: ' /A << /S /GoTo >>' }),
    fixture({ action: ' /S /VendorAction' }), fixture({ presentation: ' /Trans <<>>' }),
    fixture({ pageMode: ' /PageMode /FullScreen' }),
    ...['FileAttachment', 'Sound', 'Movie', 'Screen', 'RichMedia', '3D']
      .map((annotationSubtype) => fixture({ annotationSubtype })),
    fixture({ treeName: 'é.txt', fileName: 'é.txt' }),
    fixture({ treeName: 'tree.txt', fileName: 'file.txt' }),
    fixture({ filter: ' /Filter /FlateDecode' }), fixture({ length: 0, content: '' }),
    fixture({ length: 2, content: 'abc' }), fixture({ length: (8 * 1024 * 1024) + 1, content: 'abc' }),
  ];
  hostile.forEach((source, index) => assert.throws(() => writePdfAttachmentRemoval(source, request), { code: 'INVALID_PDF_ATTACHMENT_REMOVAL' }, `hostile-${index}`));
  for (const value of [{}, { profile: 'wrong' }, { profile: request.profile, extra: true }]) assert.throws(() => writePdfAttachmentRemoval(fixture(), value), { code: 'INVALID_PDF_ATTACHMENT_REMOVAL' });
});

test('independent inspection rejects tampering', () => {
  const source = fixture(); const result = writePdfAttachmentRemoval(source, request); const tampered = Buffer.from(result.bytes); tampered[0] ^= 1;
  assert.throws(() => inspectPdfAttachmentRemoval(source, tampered, request, result), { code: 'INVALID_PDF_ATTACHMENT_REMOVAL_OUTPUT' });
});

test('preserves the permanent file identifier and deterministically changes the revision identifier', () => {
  const source = fixture({
    id: ' /ID [<00112233445566778899AABBCCDDEEFF><FFEEDDCCBBAA99887766554433221100>]',
  });
  const result = writePdfAttachmentRemoval(source, request);
  assert.equal(result.proof.idPolicy, 'permanent-preserved-changing-updated');
  assert.deepEqual(
    inspectPdfAttachmentRemoval(source, result.bytes, request, result),
    result.proof,
  );
});

test('installed Poppler reports no embedded files after removal', async (context) => {
  if (spawnSync('pdfdetach', ['-v']).error) { context.skip('Poppler is unavailable.'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'attachment-removal-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'clean.pdf'); await writeFile(path, writePdfAttachmentRemoval(fixture(), request).bytes);
  const result = spawnSync('pdfdetach', ['-list', path], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /0 embedded files/u);
});
