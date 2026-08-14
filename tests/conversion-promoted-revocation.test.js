import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ConversionService } from '../scripts/host/conversion-service.mjs';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { HostError } from '../scripts/host/host-error.mjs';
import { InputAssetStore } from '../scripts/host/input-asset-store.mjs';
import { writeStoredZip } from '../scripts/host/pdf-ooxml-export-zip.mjs';

async function conversionHarness(context) {
  const root = await mkdtemp(join(tmpdir(), 'platen-conversion-promotion-'));
  const documents = await new DocumentStore({ root }).initialize();
  const inputs = await new InputAssetStore({ root }).initialize();
  context.after(async () => {
    await documents.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const source = await inputs.createInput({
    stream: Readable.from([Buffer.from([0xff, 0xd8, 0xff, 0xd9])]),
    displayName: 'photo.jpg',
    mediaType: 'image/jpeg',
  });
  const service = new ConversionService({
    documents,
    inputs,
    poppler: { execute: async () => ({ stdout: 'Pages: 1\n' }) },
    ghostscript: { execute: async () => { throw new Error('not used'); } },
    libreOffice: { execute: async () => { throw new Error('not used'); } },
    imageMagick: {
      execute: async (_operation, { output }) => {
        await writeFile(output, createTextPdf({ title: 'Converted image' }), { mode: 0o600 });
      },
    },
  });
  return { documents, inputs, service, source };
}

function sourceVerificationFailure(inputs) {
  const verifyInput = inputs.verifyInput.bind(inputs);
  let checks = 0;
  inputs.verifyInput = async (id) => {
    checks += 1;
    if (checks === 3) {
      throw new HostError('SOURCE_INTEGRITY_FAILED', 'The immutable conversion input no longer matches its digest.', 500);
    }
    return verifyInput(id);
  };
}

async function capturePromotedDocument(documents) {
  const promoted = [];
  const createDocument = documents.createDocument.bind(documents);
  documents.createDocument = async (...args) => {
    const document = await createDocument(...args);
    promoted.push(document);
    return document;
  };
  return promoted;
}

test('convertInputAsset revokes the promoted document after post-promotion source failure', async (context) => {
  const { documents, inputs, service, source } = await conversionHarness(context);
  const promoted = await capturePromotedDocument(documents);
  sourceVerificationFailure(inputs);

  await assert.rejects(service.convertInput(source.id), {
    code: 'SOURCE_INTEGRITY_FAILED', status: 500,
  });
  assert.equal(promoted.length, 1);
  assert.throws(() => documents.getDocument(promoted[0].id), { code: 'DOCUMENT_NOT_FOUND' });
});

test('convertInputAsset revokes the promoted document when cancellation arrives after promotion', async (context) => {
  const { documents, service, source } = await conversionHarness(context);
  const promoted = await capturePromotedDocument(documents);
  const controller = new AbortController();
  const createDocument = documents.createDocument.bind(documents);
  documents.createDocument = async (...args) => {
    const document = await createDocument(...args);
    controller.abort();
    return document;
  };

  await assert.rejects(service.convertInput(source.id, { signal: controller.signal }), {
    code: 'JOB_CANCELLED', status: 499,
  });
  assert.equal(promoted.length, 1);
  assert.throws(() => documents.getDocument(promoted[0].id), { code: 'DOCUMENT_NOT_FOUND' });
});

test('convertInputAsset leaves a promoted document intact on success', async (context) => {
  const { documents, service, source } = await conversionHarness(context);
  const deleted = [];
  const deleteDocument = documents.deleteDocument.bind(documents);
  documents.deleteDocument = async (id) => {
    deleted.push(id);
    return deleteDocument(id);
  };

  const document = await service.convertInput(source.id);
  assert.deepEqual(deleted, []);
  assert.equal(documents.getDocument(document.id).id, document.id);
});

test('ODT LibreOffice conversion revokes its promoted document on cancellation', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-office-conversion-revoke-'));
  const documents = await new DocumentStore({ root }).initialize();
  const inputs = await new InputAssetStore({ root }).initialize();
  context.after(async () => {
    await documents.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const source = await inputs.createInput({
    stream: Readable.from([writeStoredZip([
      ['mimetype', Buffer.from('application/vnd.oasis.opendocument.text')],
      ['content.xml', Buffer.from('<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body><office:text/></office:body></office:document-content>')],
      ['META-INF/manifest.xml', Buffer.from('<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/></manifest:manifest>')],
    ])]),
    displayName: 'source.odt',
    mediaType: 'application/vnd.oasis.opendocument.text',
  });
  const controller = new AbortController();
  const promoted = [];
  const createDocument = documents.createDocument.bind(documents);
  documents.createDocument = async (...args) => {
    const document = await createDocument(...args);
    promoted.push(document);
    controller.abort();
    return document;
  };
  const service = new ConversionService({
    documents,
    inputs,
    poppler: { execute: async () => ({ stdout: 'Pages: 1\n' }) },
    ghostscript: { execute: async () => { throw new Error('not used'); } },
    imageMagick: { execute: async () => { throw new Error('not used'); } },
    libreOffice: {
      execute: async (_operation, { output }) => {
        await writeFile(output, createTextPdf({ text: 'LibreOffice output' }), { mode: 0o600 });
      },
    },
  });
  await assert.rejects(service.convertInput(source.id, { signal: controller.signal }), {
    code: 'JOB_CANCELLED', status: 499,
  });
  assert.equal(promoted.length, 1);
  assert.deepEqual(promoted[0].operation.validation.validators, [
    'source-sha256', 'libreoffice-exit-zero', 'pdfinfo-page-count',
  ]);
  assert.equal(promoted[0].operation.parameters.conversionMode, 'libreoffice');
  assert.throws(() => documents.getDocument(promoted[0].id), { code: 'DOCUMENT_NOT_FOUND' });
});

test('convertInputAsset maps revocation failure to cleanup error without path leakage', async (context) => {
  const { documents, inputs, service, source } = await conversionHarness(context);
  const promoted = await capturePromotedDocument(documents);
  sourceVerificationFailure(inputs);
  documents.deleteDocument = async () => {
    throw new Error('/private/platen-conversion-promotion/derived.pdf');
  };

  await assert.rejects(service.convertInput(source.id), (error) => {
    assert.equal(error.code, 'CONVERSION_CLEANUP_FAILED');
    assert.equal(error.status, 500);
    assert.equal(error.message, 'The private conversion workspace or derived document could not be removed.');
    assert.doesNotMatch(error.message, /platen-conversion-promotion|derived\.pdf/);
    return true;
  });
  assert.equal(promoted.length, 1);
});
