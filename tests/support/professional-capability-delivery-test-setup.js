import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  deliverProfessionalCapability,
  listProfessionalHandlers,
  getProfessionalHandler,
} from '../../scripts/host/professional-capability/index.mjs';
import { resetAiPolicyForTests } from '../../scripts/host/professional-capability/local-ai.mjs';
import { validateComparisonPackage } from '../../scripts/host/comparison-package-contract.mjs';
import { inspectPdfPrinterMarks } from '../../scripts/host/pdf-printer-marks-writer.mjs';
import { createBlankPdf, createTextPdf } from '../../scripts/host/pdf-factory.mjs';
import { decodePng, encodeRgbaPng } from '../../scripts/host/raster-png-codec.mjs';
import { readZipEntries } from '../../scripts/host/zip-reader.mjs';
import { redactionFixture, formFixture, editableTextPdf } from '../../scripts/host/professional-capability/fixtures.mjs';
import { assertNoHandlerClones } from '../../scripts/check-professional-handler-clones.mjs';
import {
  contextFor,
  deterministicColorConversionContext,
  assertEffectContract as assertContract,
  cadFixture,
  pngFixture,
  printerMarksFixture,
  psFixture,
} from './professional-capability-delivery-support.js';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const capabilities = JSON.parse(readFileSync(join(root, 'catalog/capabilities.json'), 'utf8'));
const coverage = JSON.parse(readFileSync(join(root, 'catalog/prototype-coverage.json'), 'utf8'));
const effectContracts = JSON.parse(readFileSync(join(root, 'tests/fixtures/professional-capability-effect-contracts.json'), 'utf8'));
const handlerIds = [...listProfessionalHandlers()].sort();

function assertEffectContract(id, outcome) {
  assertContract(assert, effectContracts, id, outcome);
}

const THEATER_METHODS = new Set([
  'local-professional-workspace', 'local-standards-review', 'local-automation-or-platform',
  'local-security-transform', 'local-pdf-mutation-subset', 'local-viewer-state',
  'local-a11y-evidence', 'local-integration-config', 'local-automation-job-accept',
  'local-page-op-pdf', 'local-specialist-inventory', 'local-preflight-review',
  'local-scanner-inventory', 'local-pdf-portfolio', 'local-color-convert-review',
]);

export {
  assert,
  createHash,
  readFileSync,
  join,
  test,
  deliverProfessionalCapability,
  listProfessionalHandlers,
  getProfessionalHandler,
  resetAiPolicyForTests,
  validateComparisonPackage,
  inspectPdfPrinterMarks,
  createBlankPdf,
  createTextPdf,
  decodePng,
  encodeRgbaPng,
  readZipEntries,
  redactionFixture,
  formFixture,
  editableTextPdf,
  assertNoHandlerClones,
  contextFor,
  deterministicColorConversionContext,
  cadFixture,
  pngFixture,
  printerMarksFixture,
  psFixture,
  root,
  capabilities,
  coverage,
  effectContracts,
  handlerIds,
  assertEffectContract,
  assertContract,
  THEATER_METHODS,
};
