import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePdfLayerDefaults as normalizePublicLayerDefaults } from '../../src/contracts/pdf-layer-defaults-contract.js';
import {
  normalizePdfLayerDefaults as normalizeHostLayerDefaults,
} from '../../src/host/application/pdf/pdf-layer-defaults-admission.mjs';

const PROFILE_MODULES = Object.freeze([
  ['ANNOTATION_FLATTEN_PROFILE', 'pdf-annotation-flatten'],
  ['PDF_ATTACHMENT_REMOVAL_PROFILE', 'pdf-attachment-removal'],
  ['PDF_COPY_PAGE_PROFILE', 'pdf-copy-page'],
  ['PDF_FAST_WEB_VIEW_PROFILE', 'pdf-fast-web-view'],
  ['INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE', 'pdf-incremental-accessibility-metadata'],
  ['INCREMENTAL_BLEED_BOX_PROFILE', 'pdf-incremental-bleed-box'],
  ['INCREMENTAL_GOTO_LINK_PROFILE', 'pdf-incremental-goto-link'],
  ['INCREMENTAL_METADATA_PROFILE', 'pdf-incremental-metadata'],
  ['INCREMENTAL_NAMED_DESTINATION_PROFILE', 'pdf-incremental-named-destination'],
  ['INCREMENTAL_PAGE_TRANSITION_PROFILE', 'pdf-incremental-page-transition'],
  ['PDF_JAVASCRIPT_REMOVAL_PROFILE', 'pdf-javascript-removal'],
  ['PDF_LAYER_DEFAULTS_PROFILE', 'pdf-layer-defaults'],
  ['PDF_PAGE_BACKGROUND_PROFILE', 'pdf-page-background'],
  ['PDF_PAGE_HEADER_FOOTER_PROFILE', 'pdf-page-header-footer'],
  ['PDF_PAGE_TEXT_PROFILE', 'pdf-page-text'],
  ['PDF_PRINTER_MARKS_PROFILE', 'pdf-printer-marks'],
]);

test('PDF host admission modules re-export each neutral canonical profile', async () => {
  for (const [profile, stem] of PROFILE_MODULES) {
    const [contract, admission] = await Promise.all([
      import(`../../src/contracts/${stem}-contract.js`),
      import(`../../src/host/application/pdf/${stem}-admission.mjs`),
    ]);
    assert.equal(admission[profile], contract[profile], `${stem} must use the neutral ${profile}`);
  }
});

test('copy-page and fast-web-view admission metadata share their canonical contract values', async () => {
  const [copyPageContract, copyPageAdmission, fastWebViewContract, fastWebViewAdmission] = await Promise.all([
    import('../../src/contracts/pdf-copy-page-contract.js'),
    import('../../src/host/application/pdf/pdf-copy-page-admission.mjs'),
    import('../../src/contracts/pdf-fast-web-view-contract.js'),
    import('../../src/host/application/pdf/pdf-fast-web-view-admission.mjs'),
  ]);

  assert.strictEqual(copyPageAdmission.PDF_COPY_PAGE_VALIDATORS, copyPageContract.PDF_COPY_PAGE_VALIDATORS);
  assert.strictEqual(fastWebViewAdmission.PDF_FAST_WEB_VIEW_VALIDATORS, fastWebViewContract.PDF_FAST_WEB_VIEW_VALIDATORS);
  assert.strictEqual(fastWebViewAdmission.PDF_FAST_WEB_VIEW_LIMITATIONS, fastWebViewContract.PDF_FAST_WEB_VIEW_LIMITATIONS);
});

test('layer-defaults keeps its host-only strict admission normalizer', () => {
  const request = {
    sourceSha256: 'a'.repeat(64),
    changes: [{ groupIndex: 0, visible: true }],
  };
  Object.defineProperty(request, 'profile', {
    value: 'local-layer-defaults-v1', enumerable: false,
  });

  assert.doesNotThrow(() => normalizePublicLayerDefaults(request));
  assert.throws(() => normalizeHostLayerDefaults(request), { code: 'INVALID_PDF_LAYER_DEFAULTS' });
});
