import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import {
  deliverProfessionalCapability,
  getProfessionalHandler,
  listProfessionalHandlers,
} from '../scripts/host/professional-capability/index.mjs';

const DEDICATED_IDS = Object.freeze([
  'automation.api',
  'convert.html-to-pdf',
  'create.cad-to-pdf',
  'create.clipboard-to-pdf',
  'create.print-to-pdf',
  'document.embedded-files',
  'export.excel',
  'export.powerpoint',
  'export.selected-region',
  'export.word',
  'ocr.batch-recognition',
  'ocr.export-layout-preserving',
  'ocr.language-detection-selection',
  'ocr.recognize-text',
  'ocr.screenshot-capture',
  'ocr.table-recognition',
  'ocr.zones-layout',
  'platform.plugins.dependency-resolution',
  'platform.plugins.install',
  'platform.plugins.lifecycle',
  'platform.plugins.registry',
  'platform.plugins.upgrade-rollback',
]);

test('next-batch dedicated authorities reject every generic CLI and host fallback', async () => {
  const listed = new Set(listProfessionalHandlers());
  for (const capabilityId of DEDICATED_IDS) {
    assert.equal(listed.has(capabilityId), false, `${capabilityId} is absent from generic inventory`);
    assert.throws(
      () => parseCliArguments(['professional-capability', '--capability-id', capabilityId]),
      { code: 'CLI_DEDICATED_CAPABILITY_ENTRYPOINT' },
    );
    assert.throws(
      () => getProfessionalHandler(capabilityId),
      { code: 'PROFESSIONAL_DEDICATED_CAPABILITY_ENTRYPOINT' },
    );
    await assert.rejects(
      () => deliverProfessionalCapability(capabilityId, {}),
      { code: 'PROFESSIONAL_DEDICATED_CAPABILITY_ENTRYPOINT' },
    );
  }
});
