import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  inspectTaggedPdfRemediation,
  writeTaggedPdfRemediation,
} from '../scripts/host/pdf-tagged-remediation-writer.mjs';
import {
  TAGGED_PDF_REMEDIATION_PROFILE,
} from '../scripts/host/pdf-tagged-remediation-contract.mjs';

function fixture({ stream = 'q\nQ\n', pageExtra = '', streamExtra = '' } = {}) {
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  const object = (number, body) => {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  };
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R${pageExtra} >>`);
  offsets.set(4, Buffer.byteLength(chunks.join(''), 'latin1'));
  chunks.push(`4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')}${streamExtra} >>\nstream\n${stream}endstream\nendobj\n`);
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push('xref\n0 1\n0000000000 65535 f \n');
  for (const [number, offset] of offsets) chunks.push(`${number} 1\n${String(offset).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function request(source, plan) {
  return {
    profile: TAGGED_PDF_REMEDIATION_PROFILE,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    plan,
    language: 'en-US',
    title: 'Fixture',
    roleMap: {},
  };
}

function existingTaggedFixture({ priorRevision = false, duplicateMcid = false } = {}) {
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  const object = (number, body) => { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); };
  object(1, '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R /MarkInfo 7 0 R >>');
  object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /StructParents 0 >>');
  const stream = duplicateMcid ? '/P <</MCID 0>> BDC\n/P <</MCID 0>> BDC\nEMC\nEMC\n' : '/P <</MCID 0>> BDC\nq\nQ\nEMC\n';
  offsets.set(4, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream\nendobj\n`);
  object(5, '<< /Type /Pages >>'); object(6, '<< /Type /StructTreeRoot /K [8 0 R] /ParentTree 9 0 R >>'); object(7, '<< /Marked true >>');
  object(8, '<< /Type /StructElem /S /Document /P 6 0 R /K [10 0 R] >>'); object(9, '<< /Nums [0 [10 0 R]] >>'); object(10, '<< /Type /StructElem /S /P /P 8 0 R /Pg 3 0 R /K [<< /Type /MCR /Pg 3 0 R /MCID 0 >>] >>');
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 11\n0000000000 65535 f \n');
  for (let number = 1; number <= 10; number += 1) chunks.push(`${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size 11 /Root 1 0 R${priorRevision ? ` /Prev ${xref}` : ''} >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function existingRequest(source, overrides = {}) {
  const value = request(source, {
    mode: 'existing-structure-v1', id: 'document', role: 'Document', structRef: { object: 8, generation: 0 },
    children: [{ id: 'heading', role: overrides.role ?? 'H1', structRef: { object: 10, generation: 0 }, page: 1, contentIndex: 0, contentRef: { object: 4, generation: 0 }, mcid: 0 }],
  });
  value.language = null; value.title = null; return value;
}

function existingSiblingFixture() {
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  const object = (number, body) => { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); };
  object(1, '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R /MarkInfo 7 0 R >>'); object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'); object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [4 0 R 11 0 R] /StructParents 0 >>');
  const stream = (mcid) => `/P <</MCID ${mcid}>> BDC\nq\nQ\nEMC\n`;
  for (const [number, mcid] of [[4, 0], [11, 1]]) { const bytes = stream(mcid); offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n<< /Length ${Buffer.byteLength(bytes, 'latin1')} >>\nstream\n${bytes}endstream\nendobj\n`); }
  object(5, '<< /Type /Pages >>'); object(6, '<< /Type /StructTreeRoot /K [8 0 R] /ParentTree 9 0 R >>'); object(7, '<< /Marked true >>'); object(8, '<< /Type /StructElem /S /Document /P 6 0 R /K [10 0 R 12 0 R] >>'); object(9, '<< /Nums [0 [10 0 R 12 0 R]] >>'); object(10, '<< /Type /StructElem /S /P /P 8 0 R /Pg 3 0 R /K [<< /Type /MCR /Pg 3 0 R /MCID 0 >>] >>'); object(12, '<< /Type /StructElem /S /P /P 8 0 R /Pg 3 0 R /K [<< /Type /MCR /Pg 3 0 R /MCID 1 >>] >>');
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 13\n0000000000 65535 f \n'); for (let number = 1; number <= 12; number += 1) chunks.push(`${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`); chunks.push(`trailer\n<< /Size 13 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`); return Buffer.from(chunks.join(''), 'latin1');
}

function existingSiblingRequest(source, children) {
  return { ...existingRequest(source), plan: { mode: 'existing-structure-v1', id: 'document', role: 'Document', structRef: { object: 8, generation: 0 }, children } };
}

test('tagged writer is deterministic, append-only, and preserves the original content bytes', () => {
  const source = fixture();
  const plan = { id: 'document', role: 'Document', children: [{ id: 'paragraph', role: 'P', page: 1, contentIndex: 0 }] };
  const first = writeTaggedPdfRemediation(source, request(source, plan));
  const second = writeTaggedPdfRemediation(source, request(source, plan));
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.bytes.subarray(0, source.length).equals(source), true);
  assert.equal(first.proof.originalContentStreamsUnchanged, true);
  assert.equal(first.proof.structureLinked, true);
  assert.equal(first.proof.pageCount, 1);
  assert.deepEqual(inspectTaggedPdfRemediation(source, first.bytes, request(source, plan)), first.proof);
});

test('tagged writer emits Artifact as marked content without a structural MCID target', () => {
  const source = fixture();
  const plan = { id: 'document', role: 'Document', children: [{ id: 'artifact', role: 'Artifact', page: 1, contentIndex: 0 }] };
  const result = writeTaggedPdfRemediation(source, request(source, plan));
  assert.equal(result.proof.structureLinked, true);
  assert.match(result.bytes.subarray(source.length).toString('latin1'), /\/Artifact BMC/);
  assert.doesNotMatch(result.bytes.subarray(source.length).toString('latin1'), /\/Artifact <</);
});

test('tagged writer rejects filtered streams, duplicate targets, and existing tags', () => {
  const filtered = fixture({ streamExtra: ' /Filter /FlateDecode' });
  const plan = { id: 'document', role: 'Document', children: [{ id: 'paragraph', role: 'P', page: 1, contentIndex: 0 }] };
  assert.throws(() => writeTaggedPdfRemediation(filtered, request(filtered, plan)), { code: 'UNSUPPORTED_TAGGED_PDF_REMEDIATION_PDF' });
  const duplicate = fixture({ pageExtra: ' /Contents [4 0 R 4 0 R]' });
  const duplicateRequest = request(duplicate, { id: 'document', role: 'Document', children: [{ id: 'p1', role: 'P', page: 1, contentIndex: 0 }, { id: 'p2', role: 'Span', page: 1, contentIndex: 1 }] });
  assert.throws(() => writeTaggedPdfRemediation(duplicate, duplicateRequest), { code: 'UNSUPPORTED_TAGGED_PDF_REMEDIATION_PDF' });
  const tagged = fixture({ pageExtra: ' /StructParents 0' });
  assert.throws(() => writeTaggedPdfRemediation(tagged, request(tagged, plan)), { code: 'UNSUPPORTED_TAGGED_PDF_REMEDIATION_PDF' });
});

test('existing-structure mode performs source-bound role edits without inventing content', () => {
  const source = existingTaggedFixture(); const result = writeTaggedPdfRemediation(source, existingRequest(source));
  assert.equal(result.proof.tagTreeReinspected, true);
  assert.equal(result.proof.textEvidence, 'content-streams-unchanged');
  assert.equal(result.proof.renderingEvidence, 'page-geometry-and-content-preserved');
  assert.equal(result.bytes.subarray(0, source.length).equals(source), true);
  assert.deepEqual(inspectTaggedPdfRemediation(source, result.bytes, existingRequest(source)), result.proof);
});

test('existing-structure mode permits explicit artifact conversion only for a trusted MCID', () => {
  const source = existingTaggedFixture(); const result = writeTaggedPdfRemediation(source, existingRequest(source, { role: 'Artifact' }));
  assert.equal(result.proof.tagTreeReinspected, true);
  assert.match(result.bytes.subarray(source.length).toString('latin1'), /\/S \/Artifact/u);
});

test('existing-structure mode rejects duplicate MCIDs and prior revisions', () => {
  const duplicate = existingTaggedFixture({ duplicateMcid: true });
  assert.throws(() => writeTaggedPdfRemediation(duplicate, existingRequest(duplicate)), { code: 'UNSUPPORTED_TAGGED_PDF_REMEDIATION_PDF' });
  const prior = existingTaggedFixture({ priorRevision: true });
  assert.throws(() => writeTaggedPdfRemediation(prior, existingRequest(prior)), { code: 'UNSUPPORTED_TAGGED_PDF_REMEDIATION_PDF' });
});

test('existing-structure mode proves complete sibling reading-order reordering', () => {
  const source = existingSiblingFixture(); const child = (id, object, content, mcid) => ({ id, role: 'P', structRef: { object, generation: 0 }, page: 1, contentIndex: content, contentRef: { object: content === 0 ? 4 : 11, generation: 0 }, mcid });
  const first = child('first', 10, 0, 0); const second = child('second', 12, 1, 1); const result = writeTaggedPdfRemediation(source, existingSiblingRequest(source, [second, first]));
  assert.equal(result.proof.tagTreeReinspected, true); assert.equal(result.proof.structureLinked, true);
  assert.throws(() => writeTaggedPdfRemediation(source, existingSiblingRequest(source, [first])), { code: 'UNSUPPORTED_TAGGED_PDF_REMEDIATION_PDF' });
  assert.throws(() => writeTaggedPdfRemediation(source, existingSiblingRequest(source, [second, second])), { code: 'INVALID_TAGGED_PDF_REMEDIATION_REQUEST' });
});
