import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { createAcroFormChoiceEndpoints } from '../src/core/local-host-acroform-choice-endpoints.js';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAcroFormCheckboxService } from '../scripts/host/pdf-acroform-checkbox-service.mjs';
import { PdfAcroFormRadioService } from '../scripts/host/pdf-acroform-radio-service.mjs';
import { PdfAcroFormChoiceService } from '../scripts/host/pdf-acroform-choice-service.mjs';
import { inspectPdfAcroFormCheckbox } from '../scripts/host/pdf-acroform-checkbox-writer.mjs';
import { inspectPdfAcroFormRadio } from '../scripts/host/pdf-acroform-radio-writer.mjs';
import { inspectPdfAcroFormChoice } from '../scripts/host/pdf-acroform-choice-writer.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { buildClassicPassivePdf } from '../scripts/host/professional-capability/classic-structure-pdf.mjs';
import { invoke } from './support/host-router-fixture-base.js';

const TOKEN = 'a'.repeat(64);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function passivePdf({ catalogExtra = '', pageExtra = '', trailerExtra = '' } = {}) {
  const chunks = ['%PDF-1.7\n'];
  const bodies = [
    `<< /Type /Catalog /Pages 2 0 R${catalogExtra} >>`,
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 4 0 R${pageExtra} >>`,
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  const offsets = [];
  for (const [index, body] of bodies.entries()) {
    offsets.push(Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 5\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

async function fixture(t, sourceBytes = buildClassicPassivePdf({ pages: 2 })) {
  const root = await mkdtemp(join(tmpdir(), 'forms-author-routes-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(() => store.dispose());
  const document = await store.createDocument({
    stream: (async function* () { yield sourceBytes; }()),
    displayName: 'source.pdf',
  });
  const services = {
    checkbox: new PdfAcroFormCheckboxService({ store }),
    radio: new PdfAcroFormRadioService({ store }),
    choice: new PdfAcroFormChoiceService({ store }),
  };
  const app = createAppHandler({
    staticHandler: () => {}, store, service: { availability: async () => [] }, workspaceState: {},
    acroFormCheckbox: services.checkbox, acroFormRadio: services.radio, acroFormChoice: services.choice,
    token: TOKEN, host: '127.0.0.1', port: 4173,
  });
  return { app, document, root, sourceBytes, services, store };
}

function appFetch(app) {
  return async (path, options = {}) => {
    const response = await invoke(app, {
      method: options.method ?? 'GET',
      url: path,
      headers: {
        origin: 'http://127.0.0.1:4173',
        ...(options.headers ?? {}),
        ...(options.headers?.['Content-Type'] ? { 'content-type': options.headers['Content-Type'] } : {}),
        ...(options.headers?.['X-Platen-Token'] ? { 'x-platen-token': options.headers['X-Platen-Token'] } : {}),
      },
      body: options.body,
    });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
}

function requests(sourceSha256) {
  return {
    checkbox: {
      profile: 'local-pdf-acroform-checkbox-v1', sourceSha256, page: 1, fieldName: 'Approval',
      rect: { x: 72, y: 700, width: 24, height: 24 },
    },
    radio: {
      profile: 'local-pdf-acroform-radio-v1', sourceSha256, groupName: 'Delivery',
      options: [
        { label: 'Email', page: 1, rect: { x: 72, y: 650, width: 20, height: 20 } },
        { label: 'Post', page: 2, rect: { x: 108, y: 650, width: 20, height: 20 } },
      ],
    },
    choice: {
      profile: 'local-pdf-acroform-choice-v1', sourceSha256, page: 1, fieldName: 'Department',
      rect: { x: 72, y: 600, width: 180, height: 24 }, options: [{ label: 'Design' }, { label: 'Review' }],
    },
  };
}

test('forms.author creates source-bound unchecked checkbox, radio, and non-combo choice fields through authenticated routes', async (t) => {
  const state = await fixture(t);
  assert.equal(state.sourceBytes.includes(Buffer.from('/AcroForm', 'latin1')), false);
  assert.equal(state.sourceBytes.includes(Buffer.from('/Annots', 'latin1')), false);
  const client = new LocalHostClient({ fetchImpl: appFetch(state.app) });
  await client.bootstrap();
  const request = requests(state.document.sha256);
  const checkbox = await client.addAcroFormCheckbox(state.document.id, request.checkbox);
  const radio = await client.addAcroFormRadio(state.document.id, request.radio);
  const choice = await client.addAcroFormChoice(state.document.id, request.choice);

  const retained = [];
  for (const [kind, result, inspect, body] of [
    ['checkbox', checkbox, inspectPdfAcroFormCheckbox, request.checkbox],
    ['radio', radio, inspectPdfAcroFormRadio, request.radio],
    ['choice', choice, inspectPdfAcroFormChoice, request.choice],
  ]) {
    assert.equal(result.artifact.documentId, state.document.id);
    assert.notEqual(result.artifact.id, state.document.id);
    assert.equal(result.artifact.mediaType, 'application/pdf');
    assert.equal(result.artifact.sha256, result.artifact.operation.expected.outputSha256);
    assert.deepEqual(result.artifact.operation.inputs, [{ documentId: state.document.id, sha256: state.document.sha256, role: 'source' }]);
    assert.equal(result.artifact.operation.validation.passed, true);
    assert.equal(result.artifact.operation.expected.sourcePrefixPreserved, true);
    assert.equal(result.artifact.operation.expected.unchecked, true);
    assert.equal(result.artifact.operation.validation.validators.some((entry) => entry.startsWith('independent-') && entry.endsWith('-reinspection')), true);
    const artifact = state.store.getArtifact(result.artifact.id);
    const output = await readFile(artifact.filePath);
    assert.equal(digest(output), artifact.sha256);
    assert.equal(digest(output.subarray(0, state.sourceBytes.length)), state.document.sha256);
    assert.deepEqual(inspect(state.sourceBytes, output, body), result.proof);
    if (kind === 'checkbox') {
      assert.equal(result.proof.objectCount, 4);
      assert.equal(result.proof.stateName, 'Yes');
    } else if (kind === 'radio') {
      assert.equal(result.proof.options.length, 2);
      assert.equal(result.proof.options.every((entry) => entry.stateName.startsWith('Opt')), true);
    } else {
      assert.equal(result.proof.options.length, 2);
      assert.equal(result.proof.combo, false);
    }
    retained.push(result.artifact.id);
  }
  assert.equal(new Set(retained).size, 3);
  assert.match(choice.limitations.join(' '), /non-combo/);
  assert.match(checkbox.limitations.join(' '), /no radio buttons/);
});

test('forms.author binds foreign digests and rejects duplicate or invalid option geometry before authoring', async (t) => {
  const state = await fixture(t);
  const client = new LocalHostClient({ fetchImpl: appFetch(state.app) });
  await client.bootstrap();
  const request = requests(state.document.sha256);
  await assert.rejects(client.addAcroFormCheckbox(state.document.id, { ...request.checkbox, sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' });
  assert.throws(() => client.addAcroFormRadio(state.document.id, { ...request.radio, options: [{ ...request.radio.options[0], label: 'Same' }, { ...request.radio.options[1], label: 'Same' }] }), TypeError);
  assert.throws(() => client.addAcroFormRadio(state.document.id, { ...request.radio, options: [request.radio.options[0], { ...request.radio.options[1], page: request.radio.options[0].page, rect: request.radio.options[0].rect }] }), TypeError);
  assert.throws(() => client.addAcroFormChoice(state.document.id, { ...request.choice, options: [{ label: 'Same' }, { label: 'Same' }] }), TypeError);
  assert.throws(() => client.addAcroFormChoice(state.document.id, { ...request.choice, rect: { ...request.choice.rect, width: 0 } }), TypeError);
});

test('forms.author refuses existing forms/widgets and active, tagged, layered, signed, XFA, JavaScript, and encrypted inputs', async (t) => {
  const variants = [
    ['existing forms', passivePdf({ catalogExtra: ' /AcroForm 4 0 R' })],
    ['widgets', passivePdf({ pageExtra: ' /Annots [4 0 R]' })],
    ['actions', passivePdf({ catalogExtra: ' /OpenAction 4 0 R' })],
    ['JavaScript', passivePdf({ catalogExtra: ' /JavaScript 4 0 R' })],
    ['XFA', passivePdf({ catalogExtra: ' /XFA 4 0 R' })],
    ['signatures', passivePdf({ catalogExtra: ' /Perms 4 0 R' })],
    ['tags', passivePdf({ catalogExtra: ' /StructTreeRoot 4 0 R' })],
    ['layers', passivePdf({ catalogExtra: ' /OCProperties << >>' })],
    ['encryption', passivePdf({ trailerExtra: ' /Encrypt 4 0 R' })],
  ];
  for (const [label, source] of variants) {
    const state = await fixture(t, source);
    const client = new LocalHostClient({ fetchImpl: appFetch(state.app) });
    await client.bootstrap();
    const request = requests(state.document.sha256);
    for (const [kind, call] of [
      ['checkbox', () => client.addAcroFormCheckbox(state.document.id, request.checkbox)],
      ['radio', () => client.addAcroFormRadio(state.document.id, request.radio)],
      ['choice', () => client.addAcroFormChoice(state.document.id, request.choice)],
    ]) {
      await assert.rejects(call(), { code: `ACROFORM_${kind.toUpperCase()}_SOURCE_UNSUPPORTED` }, `${label} should be rejected for ${kind}`);
    }
  }
});

test('forms.author validates forged choice receipts and preserves the source when a job is cancelled after promotion', async (t) => {
  const state = await fixture(t);
  const client = new LocalHostClient({ fetchImpl: appFetch(state.app) });
  await client.bootstrap();
  const request = requests(state.document.sha256).choice;
  const result = await client.addAcroFormChoice(state.document.id, request);
  const forged = structuredClone(result);
  forged.artifact.operation.validation.outputSha256 = '0'.repeat(64);
  const endpoint = createAcroFormChoiceEndpoints({ json: async () => ({ result: forged }) });
  await assert.rejects(endpoint.addAcroFormChoice(state.document.id, request), /invalid/i);

  const controller = new AbortController();
  const base = state.store;
  const wrapped = {};
  for (const name of ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'deleteArtifact']) wrapped[name] = base[name].bind(base);
  let promotedId;
  wrapped.promotePdfArtifact = async (...args) => {
    const artifact = await base.promotePdfArtifact(...args);
    promotedId = artifact.id;
    controller.abort();
    return artifact;
  };
  await assert.rejects(new PdfAcroFormChoiceService({ store: wrapped }).add(state.document.id, request, { signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.throws(() => state.store.getArtifact(promotedId), { code: 'ARTIFACT_NOT_FOUND' });
  assert.deepEqual(await readdir(join(state.root, 'jobs')), []);
  assert.equal(digest(await readFile(state.store.getSourcePath(state.document.id))), state.document.sha256);
  const unauthenticated = await invoke(state.app, {
    method: 'POST', url: `/api/documents/${state.document.id}/acroform-choice`,
    headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' }, body: JSON.stringify(request),
  });
  assert.equal(unauthenticated.statusCode, 401);
});
