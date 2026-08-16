import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createAppHandler } from '../scripts/host/router.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfHiddenDataSanitizationService } from '../scripts/host/pdf-hidden-data-sanitization-service.mjs';
import {
  inspectPdfHiddenDataSanitization,
  PDF_HIDDEN_DATA_SANITIZER_PROFILE,
} from '../scripts/host/pdf-hidden-data-sanitizer.mjs';
import { runHiddenDataSanitizationCommand } from '../scripts/cli/commands/hidden-data-sanitization.mjs';
import { invoke } from './support/host-router-fixture-base.js';

const HIDDEN_MARKER = 'HIDDEN-DATA-PRIVATE-MARKER';
const VISIBLE_MARKER = 'VISIBLE-PAGE-CONTENT';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hiddenDataSource() {
  const metadata = `<x:xmpmeta>${HIDDEN_MARKER}</x:xmpmeta>`;
  const content = `BT (${VISIBLE_MARKER}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    `<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(metadata)} >>\nstream\n${metadata}\nendstream`,
  ];
  let body = '%PDF-1.7\n';
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'platen-sanitize-hidden-data-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(() => store.dispose());
  const sourceBytes = hiddenDataSource();
  const document = await store.createDocument({
    stream: (async function* streamSource() { yield sourceBytes; }()),
    displayName: 'source.pdf',
  });
  const hiddenDataSanitization = new PdfHiddenDataSanitizationService({ store });
  return { root, store, sourceBytes, document, hiddenDataSanitization };
}

function appHandler(state, hiddenDataSanitization = state.hiddenDataSanitization) {
  return createAppHandler({
    staticHandler() {},
    store: state.store,
    service: {},
    workspaceState: {},
    hiddenDataSanitization,
    token: 'token',
    host: '127.0.0.1',
    port: 4173,
  });
}

function requestOptions(documentId, sourceSha256, token = 'token') {
  return {
    method: 'POST',
    url: `/api/documents/${documentId}/sanitize-hidden-data`,
    headers: {
      origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json',
      'x-platen-token': token,
    },
    body: JSON.stringify({ profile: PDF_HIDDEN_DATA_SANITIZER_PROFILE, sourceSha256 }),
  };
}

async function readAndInspect(state, artifact, proof) {
  const retained = state.store.getArtifact(artifact.id);
  assert.equal(retained.documentId, state.document.id);
  assert.equal(retained.mediaType, 'application/pdf');
  assert.equal(retained.size, artifact.size);
  assert.equal(retained.sha256, artifact.sha256);
  const outputBytes = await readFile(retained.filePath);
  assert.equal(digest(outputBytes), artifact.sha256);
  assert.equal(outputBytes.length, artifact.size);
  assert.equal(outputBytes.includes(Buffer.from(HIDDEN_MARKER, 'latin1')), false);
  assert.equal(outputBytes.includes(Buffer.from(VISIBLE_MARKER, 'latin1')), true);
  const independent = inspectPdfHiddenDataSanitization(state.sourceBytes, outputBytes, {
    profile: PDF_HIDDEN_DATA_SANITIZER_PROFILE,
    sourceSha256: state.document.sha256,
  });
  assert.deepEqual(independent, proof);
  assert.equal(independent.closedClassicRevision, true);
  assert.equal(independent.orphanResidueAbsent, true);
  assert.equal(independent.priorRevisionResidueAbsent, true);
  assert.equal(independent.reachablePageContentPreserved, true);
  return { retained, outputBytes };
}

test('authenticated hidden-data route retains and independently proves the bounded artifact', async (t) => {
  const state = await setup(t);
  const response = await invoke(appHandler(state), requestOptions(state.document.id, state.document.sha256));
  assert.equal(response.statusCode, 201);
  const payload = JSON.parse(response.body.toString('utf8'));
  const result = payload.result;
  assert.equal(result.artifact.documentId, state.document.id);
  assert.equal(result.artifact.sha256, result.proof.outputSha256);
  assert.equal(result.proof.sourceSha256, state.document.sha256);
  assert.equal(result.proof.removed.xmpMetadata > 0, true);
  assert.equal(result.pdf, undefined);
  assert.equal(result.bytes, undefined);
  const disclosure = JSON.stringify(result);
  assert.equal(disclosure.includes(HIDDEN_MARKER), false);
  assert.equal(disclosure.includes('/private/'), false);
  await readAndInspect(state, result.artifact, result.proof);
  assert.equal((await readFile(state.store.getSourcePath(state.document.id))).equals(state.sourceBytes), true);
  await state.store.deleteArtifact(result.artifact.id);
  assert.deepEqual(await readdir(join(state.root, 'jobs')), []);
});

test('hidden-data route enforces authentication, exact source digest, and service availability', async (t) => {
  const state = await setup(t);
  const unauthorized = await invoke(appHandler(state), requestOptions(state.document.id, state.document.sha256, 'wrong'));
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.body.toString('utf8').includes('UNAUTHORIZED'), true);

  const stale = await invoke(appHandler(state), requestOptions(state.document.id, '0'.repeat(64)));
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.toString('utf8').includes('SOURCE_VERSION_MISMATCH'), true);
  assert.deepEqual(await readdir(join(state.root, 'jobs')), []);

  const unavailable = await invoke(appHandler(state, null), requestOptions(state.document.id, state.document.sha256));
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.toString('utf8').includes('HIDDEN_DATA_SANITIZATION_UNAVAILABLE'), true);
});

test('hidden-data CLI copies only the retained artifact and preserves bounded limitations', async (t) => {
  const state = await setup(t);
  const output = join(state.root, 'cli-output.pdf');
  const emitted = [];
  await runHiddenDataSanitizationCommand(
    { hiddenDataSanitization: state.hiddenDataSanitization, store: state.store },
    { output },
    state.document,
    null,
    undefined,
    {
      cancelled() {},
      copyExclusive: async (source, target) => copyFile(source, target, fsConstants.COPYFILE_EXCL),
      emit: async (_stdout, value) => emitted.push(value),
    },
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].localOnly, true);
  assert.equal(emitted[0].artifact.output, basename(output));
  assert.equal(emitted[0].artifact.sha256, emitted[0].proof.outputSha256);
  assert.equal(emitted[0].artifact.operation.expected.secureErasure, false);
  assert.match(emitted[0].limitations.join(' '), /does not establish visual, semantic/);
  assert.equal(Object.hasOwn(emitted[0], 'pdf'), false);
  assert.equal(Object.hasOwn(emitted[0], 'bytes'), false);
  const outputBytes = await readFile(output);
  assert.equal(outputBytes.includes(Buffer.from(HIDDEN_MARKER, 'latin1')), false);
  assert.equal(outputBytes.includes(Buffer.from(VISIBLE_MARKER, 'latin1')), true);
  const independent = inspectPdfHiddenDataSanitization(state.sourceBytes, outputBytes, {
    profile: PDF_HIDDEN_DATA_SANITIZER_PROFILE,
    sourceSha256: state.document.sha256,
  });
  assert.deepEqual(independent, emitted[0].proof);
  await state.store.deleteArtifact(emitted[0].artifact.id);
  assert.deepEqual(await readdir(join(state.root, 'jobs')), []);
});

test('hidden-data cancellation leaves no staged workspace or promoted artifact', async (t) => {
  const state = await setup(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    state.hiddenDataSanitization.sanitize(state.document.id, {
      sourceSha256: state.document.sha256,
      signal: controller.signal,
    }),
    { code: 'JOB_CANCELLED' },
  );
  assert.deepEqual(await readdir(join(state.root, 'jobs')), []);
});
