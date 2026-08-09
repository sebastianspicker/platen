import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { runOcrCommand } from '../scripts/cli/commands/ocr.mjs';
import { handleDocumentOcrRoute } from '../scripts/host/routes/document-service-route-ocr.mjs';
import { validateOcrBatchManifest, validateOcrDocumentResult } from '../src/core/ocr-contract.js';
import { makeMultiPagePdf, makeTextPdf } from './pdf-fixture.js';
import {
  createRealOcrFixture,
  driftSource,
  enginesAvailable,
  readArtifact,
  sha256,
} from './support/r06-ocr-claim-fixtures.js';

async function requireEngines(context) {
  if (!await enginesAvailable()) {
    context.skip('The fixed Poppler, Tesseract, and ImageMagick OCR engines are unavailable.');
    return false;
  }
  return true;
}

test('R06 real document OCR proves language selection, retained artifact provenance, route, and CLI output', async (context) => {
  if (!await requireEngines(context)) return;
  const fixture = await createRealOcrFixture('R06 SEARCHABLE OCR SOURCE');
  context.after(fixture.cleanup);
  const { service, store, source } = fixture;

  const languages = await service.ocrLanguages();
  assert.ok(languages.includes('eng'));
  await assert.rejects(
    service.ocrDocument(source.id, { language: 'not-installed' }),
    { code: 'OCR_LANGUAGE_UNAVAILABLE', status: 400 },
  );

  const result = validateOcrDocumentResult(await service.ocrDocument(source.id, {
    language: 'eng', cleanupPreset: 'document', segmentation: 'block', userDictionary: ['R06TERM'],
  }));
  assert.equal(result.sourceDigest, source.sha256);
  assert.equal(result.artifact.documentId, source.id);
  assert.deepEqual(result.artifact.operation.inputs[0], {
    documentId: source.id, sha256: source.sha256, role: 'primary',
  });
  assert.equal(result.artifact.operation.parameters.language, 'eng');
  assert.equal(result.result.language, 'eng');
  assert.deepEqual(result.result.userDictionary, {
    termCount: 1,
    digest: '93a194a07f79d337420cc14038005b7b28bf81c57bde1aa456b6becd9ec19892',
  });
  assert.deepEqual(result.evidence.engines, ['Poppler', 'ImageMagick', 'Tesseract']);

  const { authoritative, bytes } = await readArtifact(store, result.artifact);
  assert.equal(authoritative.sha256, sha256(bytes));
  assert.equal(authoritative.size, bytes.length);
  assert.equal(result.artifact.sha256, sha256(bytes));
  const outputDocument = await store.createDocument({
    stream: Readable.from([bytes]),
    displayName: 'r06-output.pdf',
  });
  const extracted = await service.extractText(outputDocument.id, 1);
  assert.match(extracted[0].text, /SEARCHABLE OCR SOURCE/i);

  let routeStatus;
  let routeBody;
  await handleDocumentOcrRoute({
    operation: 'ocr',
    request: {},
    response: {},
    url: new URL('http://127.0.0.1/api/documents/ocr'),
    documentId: source.id,
    processing: {},
    service,
    method() {},
    async readJson() { return { language: 'eng', cleanupPreset: 'none', segmentation: 'auto', userDictionary: [] }; },
    async normalizedOcrOptions(_service, _processing, body) { return body; },
    checkedOcrResult(value, validator) { return validator(value); },
    json(_response, status, body) { routeStatus = status; routeBody = body; },
  });
  assert.equal(routeStatus, 201);
  assert.equal(validateOcrDocumentResult(routeBody).sourceDigest, source.sha256);

  const inputPath = join(fixture.root, 'cli-input.pdf');
  const cliOutput = join(fixture.root, 'cli-output.pdf');
  await writeFile(inputPath, await readFile(store.getSourcePath(source.id)), { mode: 0o600 });
  const emitted = [];
  await runOcrCommand(
    { store, service },
    { command: 'ocr', input: inputPath, output: cliOutput, language: 'eng', cleanupPreset: 'none', segmentation: 'auto' },
    { write() {} },
    undefined,
    {
      async uploadPdf(application, input) {
        return application.store.createDocument({
          stream: Readable.from([await readFile(input)]),
          displayName: 'cli-input.pdf',
        });
      },
      async copyExclusive(from, to) { await copyFile(from, to); },
      cancelled() {},
      async emit(_stdout, value) { emitted.push(value); },
    },
  );
  assert.equal((await readFile(cliOutput)).subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(emitted.at(-1).kind, 'searchable-ocr');
  assert.deepEqual(parseCliArguments(['ocr', 'input.pdf', '--output', 'output.pdf']), {
    command: 'ocr', input: 'input.pdf', output: 'output.pdf', language: 'eng', cleanupPreset: 'document', segmentation: 'auto',
  });
});

test('R06 document OCR fails closed on source drift, forged promotion, cancellation, and page quota', async (context) => {
  if (!await requireEngines(context)) return;
  const drift = await createRealOcrFixture('R06 DRIFT SOURCE');
  context.after(drift.cleanup);
  const originalVerify = drift.store.verifySource.bind(drift.store);
  let verificationCount = 0;
  drift.store.verifySource = async (id) => {
    const result = await originalVerify(id);
    verificationCount += 1;
    if (verificationCount === 2) await driftSource(drift.store, id);
    return result;
  };
  await assert.rejects(
    drift.service.ocrDocument(drift.source.id, { language: 'eng' }),
    { code: 'SOURCE_INTEGRITY_FAILED', status: 500 },
  );

  const forged = await createRealOcrFixture('R06 FORGED ARTIFACT');
  context.after(forged.cleanup);
  const promote = forged.store.promotePdfArtifact.bind(forged.store);
  let forgedArtifactId;
  forged.store.promotePdfArtifact = async (...args) => {
    const artifact = await promote(...args);
    forgedArtifactId = artifact.id;
    return { ...artifact, sha256: 'f'.repeat(64) };
  };
  await assert.rejects(
    forged.service.ocrDocument(forged.source.id, { language: 'eng' }),
    { code: 'OCR_ARTIFACT_INVALID', status: 502 },
  );
  assert.throws(() => forged.store.getArtifact(forgedArtifactId), { code: 'ARTIFACT_NOT_FOUND' });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    forged.service.ocrDocument(forged.source.id, { language: 'eng', signal: controller.signal }),
    { code: 'JOB_CANCELLED', status: 499 },
  );

  const quota = await createRealOcrFixture('R06 QUOTA SOURCE');
  context.after(quota.cleanup);
  const tooManyPages = await quota.store.createDocument({
    stream: Readable.from([makeMultiPagePdf(Array.from({ length: 51 }, () => 'quota'))]),
    displayName: 'too-many-pages.pdf',
  });
  await assert.rejects(
    quota.service.ocrDocument(tooManyPages.id, { language: 'eng' }),
    { code: 'OCR_PAGE_LIMIT', status: 422 },
  );
  await assert.rejects(
    quota.service.ocrBatchDocuments(Array.from({ length: 9 }, (_, index) => ({ id: index + 1, documentId: quota.source.id, kind: 'document', options: {} }))),
    { code: 'INVALID_OCR_BATCH', status: 400 },
  );
});

test('R06 batch OCR returns ordered source-bound retained artifacts and aggregate evidence', async (context) => {
  if (!await requireEngines(context)) return;
  const fixture = await createRealOcrFixture('R06 BATCH ONE');
  context.after(fixture.cleanup);
  const second = await fixture.store.createDocument({
    stream: Readable.from([makeTextPdf('R06 BATCH TWO')]),
    displayName: 'r06-second.pdf',
  });
  const manifest = validateOcrBatchManifest(await fixture.service.ocrBatchDocuments([
    { id: 1, documentId: fixture.source.id, kind: 'document', options: { language: 'eng', cleanupPreset: 'none' } },
    { id: 2, documentId: second.id, kind: 'document', options: { language: 'eng', cleanupPreset: 'none' } },
  ]));
  assert.equal(manifest.status, 'succeeded');
  assert.equal(manifest.evidence.ordered, true);
  assert.equal(manifest.evidence.sequential, true);
  assert.deepEqual(manifest.requests.map(({ id, status }) => ({ id, status })), [{ id: 1, status: 'completed' }, { id: 2, status: 'completed' }]);
  for (const [index, entry] of manifest.requests.entries()) {
    const expected = index === 0 ? fixture.source : second;
    assert.equal(entry.output.sourceDigest, expected.sha256);
    const { authoritative, bytes } = await readArtifact(fixture.store, entry.output.artifact);
    assert.equal(authoritative.sha256, sha256(bytes));
    assert.equal(entry.output.artifact.sha256, sha256(bytes));
  }
});
