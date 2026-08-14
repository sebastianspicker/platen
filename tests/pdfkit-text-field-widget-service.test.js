import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import {
  digestTextFieldWidgetDefaultValue,
  digestTextFieldWidgetRect,
  normalizeTextFieldWidgetRequest,
} from '../scripts/host/pdfkit-text-field-widget-contract.mjs';
import { PdfKitTextFieldWidgetService } from '../scripts/host/pdfkit-text-field-widget-service.mjs';
import { makeTextPdf } from './pdf-fixture.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(16).fill(0)]);
const request = {
  page: 1,
  rect: { x: 36, y: 36, width: 180, height: 24 },
  fieldName: 'Account.Name',
  defaultValue: 'Local value',
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('text-field contract accepts only the exact canonical bounded request', () => {
  const value = { sourceSha256: 'a'.repeat(64), ...request };
  assert.deepEqual(normalizeTextFieldWidgetRequest(value, { pageCount: 1 }), value);
  for (const invalid of [
    { ...value, action: 'launch' },
    { ...value, rect: { left: 36, y: 36, width: 180, height: 24 } },
    { ...value, fieldName: ' unsafe' },
    { ...value, defaultValue: 'unsafe\nvalue' },
    { ...value, sourceSha256: 'A'.repeat(64) },
  ]) assert.throws(
    () => normalizeTextFieldWidgetRequest(invalid, { pageCount: 1 }),
    { code: 'INVALID_PDFKIT_TEXT_FIELD_WIDGET' },
  );
});

test('text-field service accepts the route signal and promotes profile-bound provenance through DocumentStore', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pdfkit-text-field-service-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const sourceBytes = makeTextPdf('Text-field source');
  const outputBytes = makeTextPdf('Text-field derived output');
  const document = await store.createDocument({
    stream: Readable.from([sourceBytes]), displayName: 'source.pdf',
  });
  const outputSha256 = sha256(outputBytes);
  const poppler = {
    async execute(operation, parameters) {
      if (operation === 'inspect') {
        const output = parameters.input.endsWith('output.pdf');
        return {
          stdout: `Pages: 1\nEncrypted: no\nForm: ${output ? 'AcroForm' : 'none'}\nJavaScript: no\nTagged: no\nSuspects: no\n`,
        };
      }
      if (operation === 'inspectUrls' || operation === 'inspectStructure') return { stdout: '' };
      if (operation === 'verifySignatures') {
        return { stdout: `File '${parameters.input}' does not contain any signatures\n`, stderr: '', exitCode: 0 };
      }
      if (operation === 'inspectPage') {
        return { stdout: 'Page 1 size: 612 x 792 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 612 792\nPage 1 CropBox: 0 0 612 792\n' };
      }
      if (operation === 'renderPagePng') {
        await writeFile(`${parameters.outputPrefix}.png`, png, { mode: 0o600 });
        return { stdout: '' };
      }
      assert.fail(`unexpected Poppler operation ${operation}`);
    },
  };
  const adapter = {
    async addTextFieldWidget({ workspacePath, requestPath }) {
      const nativeRequest = JSON.parse(await readFile(requestPath, 'utf8'));
      assert.equal(nativeRequest.operation, 'addTextFieldWidget');
      assert.equal(nativeRequest.sourceSha256, document.sha256);
      assert.deepEqual(nativeRequest.field, {
        page: 1, rect: request.rect, name: request.fieldName,
        defaultValue: request.defaultValue,
      });
      await writeFile(join(workspacePath, 'output.pdf'), outputBytes, { mode: 0o600 });
      return {
        schema: 'pdfkit-text-field-widget-receipt-v1', version: 1,
        operation: 'addTextFieldWidget', category: 'acroform-text-field-widget',
        sourceSha256: document.sha256, outputSha256,
        fieldNameSha256: sha256(Buffer.from(request.fieldName, 'utf8')),
        defaultValueSha256: digestTextFieldWidgetDefaultValue(request.defaultValue),
        rectSha256: digestTextFieldWidgetRect(request.rect),
        page: 1, pageCount: 1, appliedEdits: 1,
        directAcroFormTopologyVerified: true, terminalTextWidgetVerified: true,
        sourceSafetyVerified: true, preservationVerified: true, reopenVerified: true,
      };
    },
  };
  const service = new PdfKitTextFieldWidgetService({ store, poppler, adapter });
  const signal = new AbortController().signal;
  const result = await service.addTextFieldWidget(document.id, {
    sourceSha256: document.sha256, ...request, signal,
  });
  const retained = store.getArtifact(result.artifact.id);
  assert.equal(retained.sha256, outputSha256);
  assert.equal(retained.operation.type, 'pdfkit-acroform-text-field-widget');
  assert.equal(
    retained.operation.parameters.profile,
    'macos-pdfkit-acroform-text-field-widget-v1',
  );
  assert.deepEqual(retained.operation.inputs, [{
    documentId: document.id, sha256: document.sha256, role: 'source',
  }]);
  assert.equal(retained.operation.validation.outputSha256, outputSha256);

  await assert.rejects(service.addTextFieldWidget(document.id, {
    sourceSha256: document.sha256, ...request, action: 'launch',
  }), { code: 'INVALID_PDFKIT_TEXT_FIELD_WIDGET' });
});
