import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import {
  chmod, link, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationSourceStore } from '../../scripts/host/automation/automation-source-store.mjs';
import { AutomationOperationRegistry, AUTOMATION_INSPECT_TYPE, AUTOMATION_OCR_TYPE, AUTOMATION_OUTPUT_INTENT_TYPE } from '../../scripts/host/automation/automation-operation-registry.mjs';
import { AutomationWorker } from '../../scripts/host/automation/automation-worker.mjs';
import { DurableLocalJobQueue } from '../../scripts/host/automation/durable-local-job-queue.mjs';
import { runAutomationCommand } from '../../scripts/cli/commands/automation.mjs';
import * as cliRuntime from '../../scripts/cli/runtime.mjs';
import { DocumentStore } from '../../scripts/host/document-store.mjs';
import { parseCliArguments } from '../../scripts/platen-cli.mjs';
import { makeTextPdf } from '../pdf-fixture.js';
import {
  FULL_PAGE_REDACTION_BATCH_LIMITATIONS,
  FULL_PAGE_REDACTION_BATCH_PROFILE,
  FULL_PAGE_REDACTION_LIMITATIONS,
  FULL_PAGE_REDACTION_PROFILE,
  FULL_PAGE_REDACTION_VALIDATORS,
} from '../../src/core/pdf-full-page-redaction-contract.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-automation-'));
  const automationRoot = join(root, 'automation');
  await mkdir(automationRoot, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, automationRoot, bytes: makeTextPdf('AUTOMATION SOURCE') };
}

async function documentStore(root, bytes, name = 'source.pdf') {
  const store = await new DocumentStore({ root }).initialize();
  const document = await store.createDocument({
    stream: Readable.from([bytes]), displayName: name, mediaType: 'application/pdf',
  });
  return { store, document };
}

function executionStore() {
  const documents = new Map();
  let sequence = 0;
  return {
    documents,
    async createDocument({ stream }) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const document = {
        id: `document_${++sequence}`, size: bytes.length, sha256: digest(bytes),
      };
      documents.set(document.id, document);
      return document;
    },
    async deleteDocument(id) { documents.delete(id); },
  };
}

const inspection = Object.freeze({
  pageCount: 1, pdfVersion: '1.7', encrypted: 'no', tagged: 'no', optimized: 'no',
});

function ocrOutput({
  sourceSha256,
  documentId,
  artifactDocumentId = documentId,
  artifactSize = 100,
  artifactSha256 = 'd'.repeat(64),
  userDictionaryEvidence = { termCount: 0, digest: null },
}) {
  const digestValue = 'b'.repeat(64);
  const cleanupReceipts = [{
    page: 1, applied: true, preset: 'document',
    pre: { sha256: digestValue, width: 100, height: 100 },
    post: { sha256: 'c'.repeat(64), width: 100, height: 100 }, canvasPreserved: true,
  }];
  return {
    kind: 'searchable-ocr-document', schemaVersion: 1, sourceDigest: sourceSha256,
    artifact: {
      id: '44444444-4444-4444-8444-444444444444', documentId: artifactDocumentId,
      displayName: 'ocr.pdf', mediaType: 'application/pdf', size: artifactSize,
      sha256: artifactSha256,
      operation: {
        schemaVersion: 1, id: '55555555-5555-4555-8555-555555555555',
        type: 'searchable-ocr',
        inputs: [{ documentId: artifactDocumentId, sha256: sourceSha256, role: 'primary' }],
        parameters: {
          language: 'eng', pages: 1, rasterized: true, cleanupPreset: 'document',
          segmentation: 'auto', userDictionary: userDictionaryEvidence, cleanupReceipts,
        }, expected: { pageCount: 1, extractableText: true },
        validation: { passed: true, validators: ['source-sha256'], pageCount: 1, recognizedWordCount: 1 },
        completedAt: '2026-01-01T00:00:00.000Z',
      }, createdAt: '2026-01-01T00:00:00.000Z',
    },
    result: {
      language: 'eng', pageCount: 1, recognizedWordCount: 1, rasterized: true,
      cleanupPreset: 'document', segmentation: 'auto',
      userDictionary: userDictionaryEvidence, suspects: [],
    },
    evidence: {
      localOnly: true, sourceBound: true,
      engines: ['Poppler', 'ImageMagick', 'Tesseract'], rasterized: true,
      reviewRequired: true, cleanupReceipts,
    }, limitations: ['Review against the immutable source PDF.'],
  };
}

function fullPageRedactionOutput({ sourceSha256, documentId, page, artifactPath, artifactBytes, pages = null }) {
  const artifactSha256 = digest(artifactBytes);
  const batch = Array.isArray(pages);
  const artifact = {
    id: `44444444-4444-4${page}44-8444-444444444444`,
    documentId,
    displayName: `redacted-${page}.pdf`,
    mediaType: 'application/pdf',
    size: artifactBytes.length,
    sha256: artifactSha256,
    operation: {
      schemaVersion: 1,
      id: `55555555-5555-4${page}55-8555-555555555555`,
      type: batch ? 'pdf-full-page-redaction-batch' : 'pdf-full-page-redaction',
      inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
      parameters: batch ? { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, pages } : { profile: FULL_PAGE_REDACTION_PROFILE, page },
      expected: batch ? { pageCount: 1, sourceUnchanged: true, closedCompactRewrite: true, fullPageOnly: true } : { pageCount: 1, sourceUnchanged: true, closedCompactRewrite: true, fullPageOnly: true },
      validation: {
        passed: true, validators: FULL_PAGE_REDACTION_VALIDATORS,
        pageCount: 1, ...(batch ? { targetPages: pages } : { targetPage: page }), outputSha256: artifactSha256,
      },
      completedAt: '2026-01-01T00:00:00.000Z',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    ...(batch ? { kind: 'pdf-full-page-redaction-batch', pages } : { kind: 'pdf-full-page-redaction', redaction: { page, fullPage: true } }), sourceDigest: sourceSha256, artifact,
    evidence: batch ? {
      sourceDigestReverified: true, closedCompactRewrite: true, targetContentResourcesRemoved: true,
      pageCountMatched: true, targetTextEmpty: true, targetPagesBlack: true, nonTargetTextRenderMatched: true, outputUnsigned: true,
      attachmentsAbsent: true, urlsAbsent: true, artifactDigestBound: true, sourceUnchanged: true, fullPageOnly: true, localOnly: true,
    } : {
      sourceDigestReverified: true, closedCompactRewrite: true,
      targetContentResourcesRemoved: true, pageCountMatched: true,
      targetTextEmpty: true, targetRenderBlack: true,
      nonTargetTextRenderMatched: true, outputUnsigned: true,
      attachmentsAbsent: true, urlsAbsent: true, artifactDigestBound: true,
      sourceUnchanged: true, localOnly: true,
    },
    limitations: batch ? FULL_PAGE_REDACTION_BATCH_LIMITATIONS : FULL_PAGE_REDACTION_LIMITATIONS,
  };
}

function outputCapture() {
  const chunks = [];
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }),
    value: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
  };
}

function transientOcrStore(source, artifactPath, artifactBytes) {
  const documentId = '66666666-6666-4666-8666-666666666666';
  const artifact = {
    id: '44444444-4444-4444-8444-444444444444',
    documentId,
    displayName: 'ocr.pdf',
    mediaType: 'application/pdf',
    size: artifactBytes.length,
    sha256: digest(artifactBytes),
    filePath: artifactPath,
  };
  return {
    artifact,
    store: {
      async createDocument({ stream }) {
        const chunks = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        assert.equal(digest(bytes), source.sha256);
        return { id: documentId, sha256: source.sha256, size: source.size };
      },
      getArtifact(id) {
        assert.equal(id, artifact.id);
        return Object.freeze({ ...artifact });
      },
      async deleteDocument(id) {
        assert.equal(id, documentId);
        await rm(artifactPath, { force: true });
      },
    },
    service: {
      async ocrDocument(id, options) {
        assert.equal(id, documentId);
        const terms = options.userDictionary ?? [];
        const userDictionaryEvidence = {
          termCount: terms.length,
          digest: terms.length > 0
            ? createHash('sha256').update(`${terms.join('\n')}\n`, 'utf8').digest('hex')
            : null,
        };
        return ocrOutput({
          sourceSha256: source.sha256,
          documentId,
          artifactSize: artifact.size,
          artifactSha256: artifact.sha256,
          userDictionaryEvidence,
        });
      },
    },
  };
}

function transientOutputIntentExecution(source, artifactPath, artifactBytes) {
  const documentId = '66666666-6666-4666-8666-666666666666';
  const profile = {
    id: 'ghostscript-default-cmyk',
    colorSpace: 'CMYK',
    size: 256,
    sha256: 'e'.repeat(64),
  };
  const artifact = {
    id: '44444444-4444-4444-8444-444444444444',
    documentId,
    displayName: 'output-intent.pdf',
    mediaType: 'application/pdf',
    size: artifactBytes.length,
    sha256: digest(artifactBytes),
    filePath: artifactPath,
  };
  const proof = {
    schema: 'pdf-output-intent-assignment-proof-v1',
    version: 1,
    sourceSha256: source.sha256,
    outputSha256: artifact.sha256,
    profileSha256: profile.sha256,
    profileBytes: profile.size,
    outputIntentCount: 1,
    closedClassicRevision: true,
  };
  artifact.operation = {
    type: 'ghostscript-cmyk-output-intent',
    inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
    parameters: {
      profileId: profile.id,
      profileSha256: profile.sha256,
      profileBytes: profile.size,
    },
    expected: {
      outputIntentCount: 1,
      embeddedProfileSha256: profile.sha256,
    },
    validation: {
      outputSha256: artifact.sha256,
      profileSha256: profile.sha256,
      outputIntentCount: 1,
    },
  };
  return {
    artifact,
    store: {
      async createDocument({ stream }) {
        const chunks = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        assert.equal(digest(bytes), source.sha256);
        return { id: documentId, sha256: source.sha256, size: source.size };
      },
      getArtifact(id) {
        assert.equal(id, artifact.id);
        return Object.freeze({ ...artifact });
      },
      async deleteDocument(id) {
        assert.equal(id, documentId);
        await rm(artifactPath, { force: true });
      },
    },
    outputIntentService: {
      async assign(id, request, options) {
        assert.equal(id, documentId);
        assert.deepEqual(request, {
          profile: 'local-ghostscript-default-cmyk-output-intent-v1',
          sourceSha256: source.sha256,
        });
        assert(options.signal instanceof AbortSignal);
        return {
          kind: 'output-intent-artifact',
          schemaVersion: 1,
          sourceDigest: source.sha256,
          artifact,
          profile,
          proof,
          receipt: {
            outputSha256: artifact.sha256,
            pageCount: 1,
            pageGeometryPreserved: true,
            textExtractionEquivalent: true,
            everyPageRendered: true,
            outputIntentCount: 1,
            pdfXValidated: false,
          },
          authoritative: false,
        };
      },
    },
  };
}

export {
  assert, createHash, chmod, link, mkdtemp, mkdir, readFile, readdir, rename, rm, stat,
  symlink, writeFile, tmpdir, join, Readable, Writable,
  AutomationSourceStore, AutomationOperationRegistry, AutomationWorker,
  DurableLocalJobQueue, runAutomationCommand, cliRuntime, DocumentStore,
  parseCliArguments, makeTextPdf, AUTOMATION_INSPECT_TYPE, AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_TYPE, digest, fixture, documentStore, executionStore,
  inspection, ocrOutput, outputCapture, transientOcrStore,
  transientOutputIntentExecution, fullPageRedactionOutput,
};
