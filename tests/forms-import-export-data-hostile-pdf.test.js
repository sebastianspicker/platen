import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAcroFormDataExportService } from '../scripts/host/pdf-acroform-data-export-service.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
function pdf(objects) {
  let body = '%PDF-1.7\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body, 'latin1')); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(body, 'latin1'); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
function form({ catalog = '', acro = '', fields = '6 0 R', field = '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Field) /V (Ada) >>', extra = [] } = {}) {
  return pdf([`<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R ${catalog} >>`, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>', '<< >>', `<< /Fields [${fields}] ${acro} >>`, field, ...extra]);
}
async function state(t, bytes) { const root = await mkdtemp(join(tmpdir(), 'acroform-export-hostile-')); const store = await new DocumentStore({ root }).initialize(); t.after(() => store.dispose()); const document = await store.createDocument({ stream: (async function* () { yield bytes; }()), displayName: 'form.pdf' }); return { root, store, document }; }
async function exportForm(t, bytes) { const value = await state(t, bytes); const service = new PdfAcroFormDataExportService({ store: value.store }); return { value, result: service.export(value.document.id, { profile: 'local-acroform-data-export-v1', sourceSha256: value.document.sha256 }) }; }

test('structurally valid classic PDFs admit only the narrow terminal Tx CSV subset', async (t) => {
  const inherited = form({ fields: '6 0 R', field: '<< /FT /Tx /T (Inherited) /V (ParentValue) /Kids [7 0 R] >>', extra: ['<< /Kids [8 0 R] >>', '<< /Type /Annot /Subtype /Widget >>'] });
  const utfInherited = form({ fields: '6 0 R', field: '<< /FT /Tx /T <FEFF004600690065006C0064> /V <FEFF00C400640061> /Kids [7 0 R] >>', extra: ['<< /Kids [8 0 R] >>', '<< /Type /Annot /Subtype /Widget >>'] });
  const cases = [
    ['absent V', form({ field: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Empty) >>' }), { field: 'Empty', value: '' }],
    ['direct V', form(), { field: 'Field', value: 'Ada' }],
    ['inherited V', inherited, { field: 'Inherited', value: 'ParentValue' }],
    ['direct UTF-16BE T/V', form({ field: '<< /Type /Annot /Subtype /Widget /FT /Tx /T <FEFF004600690065006C0064> /V <FEFF00C400640061> >>' }), { field: 'Field', value: 'Äda' }],
    ['inherited UTF-16BE T/V', utfInherited, { field: 'Field', value: 'Äda' }],
    ['duplicate root alias', form({ fields: '6 0 R 6 0 R' })],
    ['two widgets', form({ fields: '6 0 R 7 0 R', extra: ['<< /Type /Annot /Subtype /Widget /FT /Tx /T (Second) /V (B) >>'] })],
    ['catalog OpenAction', form({ catalog: '/OpenAction <<>>' })], ['catalog Names', form({ catalog: '/Names <<>>' })], ['catalog AA', form({ catalog: '/AA <<>>' })], ['catalog Perms', form({ catalog: '/Perms <<>>' })],
    ['AcroForm XFA', form({ acro: '/XFA []' })], ['AcroForm CO', form({ acro: '/CO []' })], ['AcroForm AA', form({ acro: '/AA <<>>' })], ['SigFlags 1', form({ acro: '/SigFlags 1' })], ['SigFlags 3', form({ acro: '/SigFlags 3' })],
    ['field A', form({ field: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Field) /V (Ada) /A <<>> >>' })], ['field AA', form({ field: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Field) /V (Ada) /AA <<>> >>' })], ['field JS', form({ field: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Field) /V (Ada) /JS (x) >>' })],
    ['Sig', form({ field: '<< /Type /Annot /Subtype /Widget /FT /Sig /T (Field) >>' })], ['Btn', form({ field: '<< /Type /Annot /Subtype /Widget /FT /Btn /T (Field) >>' })],
    ['non-string name', form({ field: '<< /Type /Annot /Subtype /Widget /FT /Tx /T 1 /V (Ada) >>' })], ['array V', form({ field: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Field) /V [] >>' })],
    ['odd UTF-16BE', form({ field: '<< /Type /Annot /Subtype /Widget /FT /Tx /T <FEFF00> /V (Ada) >>' })], ['unsupported bytes', form({ field: '<< /Type /Annot /Subtype /Widget /FT /Tx /T <80> /V (Ada) >>' })],
    ['depth > 2', form({ field: '<< /FT /Tx /T (Deep) /Kids [7 0 R] >>', extra: ['<< /Kids [8 0 R] >>', '<< /Kids [9 0 R] >>', '<< /Type /Annot /Subtype /Widget >>'] })],
  ];
  for (const [label, bytes, expected] of cases) {
    const { value, result } = await exportForm(t, bytes);
    if (expected) { const output = await result; assert.match(output.csv, new RegExp(`"${expected.field}","${expected.value}"`), label); }
    else await assert.rejects(result, { code: 'ACROFORM_DATA_EXPORT_SOURCE_UNSUPPORTED' }, label);
    assert.deepEqual(await readdir(join(value.root, 'jobs')), [], label);
  }
});
