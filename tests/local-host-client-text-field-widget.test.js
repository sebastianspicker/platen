import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';

const token = 'a'.repeat(64);
const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'b'.repeat(64);
const outputSha256 = 'c'.repeat(64);
const request = {
  page: 1,
  rect: { x: 36, y: 36, width: 180, height: 24 },
  fieldName: 'Account.Name',
  defaultValue: 'Local value',
};

function validResult() {
  const fieldNameSha256 = 'd'.repeat(64);
  const defaultValueSha256 = 'e'.repeat(64);
  const rectSha256 = 'f'.repeat(64);
  return {
    kind: 'pdfkit-acroform-text-field-widget', sourceDigest: sourceSha256,
    artifact: {
      id: artifactId, documentId, displayName: 'source-text-field-widget.pdf',
      mediaType: 'application/pdf', size: 512, sha256: outputSha256,
      operation: {
        schemaVersion: 1, id: operationId, type: 'pdfkit-acroform-text-field-widget',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: {
          profile: 'macos-pdfkit-acroform-text-field-widget-v1', page: 1,
          fieldNameSha256, defaultValueSha256, rectSha256,
        },
        expected: { pageCount: 1, rasterized: false, editCount: 1 },
        validation: {
          passed: true,
          validators: [
            'source-sha256', 'pinned-helper-sha256', 'source-safety',
            'direct-acroform-topology', 'terminal-text-widget', 'pdfkit-reopen',
            'poppler-page-count', 'poppler-render-all-pages', 'artifact-sha256',
          ],
          pageCount: 1, renderedPages: 1, appliedEdits: 1, outputSha256,
        },
        completedAt: '2026-07-20T00:00:00.000Z',
      },
      createdAt: '2026-07-20T00:00:00.000Z',
    },
    page: 1, fieldNameSha256, defaultValueSha256, rectSha256,
    evidence: {
      engine: 'Apple PDFKit', helperBinaryDigestVerified: true,
      sourceDigestReverified: true, directAcroFormTopologyVerified: true,
      terminalTextWidgetVerified: true, sourceSafetyVerified: true,
      preservationVerified: true, reopenedByPdfKit: true,
      popplerPageCountMatched: true, allPagesRendered: true,
      outputSha256, rasterized: false, sourceUnchanged: true,
    },
    limitations: [
      'This creates exactly one direct terminal text AcroForm widget in a separate derived PDF.',
      'Existing forms, widgets, signatures, encryption, actions, tags, layers, and unsupported PDF graphs are rejected.',
      'Field name and default value are retained only as SHA-256 digests in host results and provenance.',
      'This is not PDF/A, PDF/UA, redaction, sanitization, signature preservation, or byte-preservation validation.',
    ],
  };
}

async function clientFor(result, calls = []) {
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') {
      return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    }
    return new Response(JSON.stringify({ result }), { status: 201 });
  } });
  await client.bootstrap();
  return client;
}

test('LocalHostClient sends one exact text-field request and validates the full source-bound result', async () => {
  const calls = [];
  const client = await clientFor(validResult(), calls);
  const controller = new AbortController();
  const result = await client.addPdfKitTextFieldWidget(
    documentId, sourceSha256, request, { signal: controller.signal },
  );
  assert.equal(result.artifact.sha256, outputSha256);
  assert.equal(calls[1].path, `/api/documents/${documentId}/pdfkit-text-field-widget`);
  assert.equal(calls[1].options.signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    profile: 'macos-pdfkit-acroform-text-field-widget-v1',
    sourceSha256,
    ...request,
  });
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
});

test('LocalHostClient rejects request drift and a digest-unbound text-field result', async () => {
  const client = await clientFor(validResult());
  for (const invalid of [
    { ...request, extra: true },
    { ...request, rect: { left: 36, y: 36, width: 180, height: 24 } },
    { ...request, fieldName: ' unsafe' },
    { ...request, defaultValue: 'unsafe\nvalue' },
    { ...request, defaultValue: 'é'.repeat(129) },
  ]) assert.throws(
    () => client.addPdfKitTextFieldWidget(documentId, sourceSha256, invalid),
    TypeError,
  );

  const tampered = validResult();
  tampered.artifact.operation.validation.outputSha256 = '0'.repeat(64);
  const tamperedClient = await clientFor(tampered);
  await assert.rejects(
    tamperedClient.addPdfKitTextFieldWidget(documentId, sourceSha256, request),
    { code: 'INVALID_LOCAL_HOST' },
  );
});
