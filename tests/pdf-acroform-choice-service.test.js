import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAcroFormChoiceService } from '../scripts/host/pdf-acroform-choice-service.mjs';

function source() {
  const chunks = ['%PDF-1.7\n']; const bodies = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream']; const offsets = [];
  for (let index = 0; index < bodies.length; index += 1) { offsets.push(Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${index + 1} 0 obj\n${bodies[index]}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push(`xref\n0 5\n0000000000 65535 f \n${offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`); return Buffer.from(chunks.join(''), 'latin1');
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function request(bytes) { return { profile: 'local-pdf-acroform-choice-v1', sourceSha256: digest(bytes), page: 1, fieldName: 'Choice', rect: { x: 36, y: 700, width: 180, height: 20 }, options: [{ label: 'First' }, { label: 'Second' }] }; }
async function setup(context) { const root = await mkdtemp(join(tmpdir(), 'pdf-acroform-choice-service-')); const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose()); const bytes = source(); const document = await store.createDocument({ stream: (async function* () { yield bytes; }()), displayName: 'source.pdf' }); return { store, bytes, document, service: new PdfAcroFormChoiceService({ store }) }; }

test('choice service stages, verifies, promotes, and cleans', async (context) => { const value = await setup(context); const result = await value.service.add(value.document.id, request(value.bytes)); assert.equal(result.artifact.documentId, value.document.id); assert.match(result.artifact.sha256, /^[0-9a-f]{64}$/u); assert.ok(result.artifact.size > value.bytes.length); assert.notEqual(result.artifact.id, value.document.id); assert.equal(result.proof.options.length, 2); assert.deepEqual(await readdir(join(value.store.root, 'jobs')), []); });
test('choice service maps source drift, hostile request descriptors, and cancellation', async (context) => { const value = await setup(context); await assert.rejects(value.service.add(value.document.id, { ...request(value.bytes), sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' }); const hostile = request(value.bytes); Object.defineProperty(hostile.options[0], 'label', { enumerable: true, get: () => 'First' }); await assert.rejects(value.service.add(value.document.id, hostile), { code: 'INVALID_ACROFORM_CHOICE_OPTIONS' }); const controller = new AbortController(); controller.abort(); await assert.rejects(value.service.add(value.document.id, request(value.bytes), { signal: controller.signal }), { code: 'JOB_CANCELLED' }); });
