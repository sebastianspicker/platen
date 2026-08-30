import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HostError } from '../../src/host/platform/runtime/host-error.mjs';
import {
  MAX_JOB_WORKSPACE_BYTES,
  MAX_OCR_RASTER_BYTES,
  PNG_SIGNATURE,
} from '../../src/host/platform/runtime/resource-limits.mjs';
import {
  MAX_JOB_WORKSPACE_BYTES as pdfWorkspaceBytes,
  MAX_OCR_RASTER_BYTES as pdfRasterBytes,
  PNG_SIGNATURE as pdfPngSignature,
} from '../../src/host/application/pdf/pdf-service-limits.mjs';
import { normalizeTextFieldWidgetRequest } from '../../src/host/platform/adapters/pdfkit/text-field-widget-protocol.mjs';
import { promoteComparisonPackageArtifact } from '../../src/host/platform/storage/document-store-comparison-artifact.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

function source(path) {
  return readFileSync(join(repositoryRoot, path), 'utf8');
}

test('platform seams own their shared contracts without importing application modules', () => {
  assert.equal(source('src/host/platform/adapters/pdfkit/execution-adapter.mjs').includes('../../pdf/'), false);
  assert.equal(source('src/host/platform/adapters/pdfkit/text-field-widget-protocol.mjs').includes('../../pdf/'), false);
  assert.equal(source('src/host/platform/adapters/verapdf.mjs').includes('../security/'), false);
  assert.equal(source('src/host/platform/runtime/bounded-output-io.mjs').includes('../pdf/'), false);
  assert.equal(source('src/host/platform/storage/workspace-job-runtime.mjs').includes('../pdf/'), false);
  assert.equal(source('src/host/platform/storage/input-asset-store.mjs').includes('../documents/'), false);
  assert.equal(source('src/host/platform/storage/document-store-comparison-artifact.mjs').includes('../review/'), false);
});

test('PDFKit helper protocol uses platform validation and shared resource limits', () => {
  assert.throws(
    () => normalizeTextFieldWidgetRequest({
      sourceSha256: '0'.repeat(64), page: 0,
      rect: { x: 0, y: 0, width: 1, height: 1 }, fieldName: 'Field', defaultValue: null,
    }),
    (error) => error instanceof HostError && error.code === 'INVALID_PDFKIT_TEXT_FIELD_WIDGET',
  );
  assert.equal(pdfWorkspaceBytes, MAX_JOB_WORKSPACE_BYTES);
  assert.equal(pdfRasterBytes, MAX_OCR_RASTER_BYTES);
  assert.equal(pdfPngSignature, PNG_SIGNATURE);
});

test('comparison artifact storage requires caller-supplied package metadata and validation', async () => {
  await assert.rejects(
    promoteComparisonPackageArtifact({}, 'primary', 'revision', '/missing/package'),
    /Comparison package metadata must provide bounded format details and a validator/u,
  );
});
