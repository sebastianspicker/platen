import assert from 'node:assert/strict';
import test from 'node:test';
import { rasterEditSections } from '../src/ui/editor-inspector/raster-edit-sections.js';

function state(result = null) {
  return {
    cropRegion: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    resizeWidth: 612, resizeHeight: 792, overlayPlacement: 'watermark', overlayText: 'CONFIDENTIAL',
    redactionText: '', redactionFullPage: false,
    redactionRegion: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
    redactionPlans: [], selectedRedactionPlanId: '', selectedRedactionMarkId: '',
    fullPageRedactionResult: result,
  };
}

test('full-page object redaction control is gated and advertises its narrow limits', () => {
  const disabled = rasterEditSections(state(), {
    ready: true, rasterAvailable: true, redactionPlanReady: false,
    redactionPlanReportReady: false, fullPageRedactionReady: false,
  });
  assert.match(disabled, /data-action="create-full-page-object-redaction" disabled/);

  const enabled = rasterEditSections(state({
    kind: 'pdf-full-page-redaction',
    artifact: { displayName: 'redacted.pdf' },
    redaction: { page: 2, fullPage: true },
    evidence: { closedCompactRewrite: true, targetContentResourcesRemoved: true, targetTextEmpty: true, targetRenderBlack: true, nonTargetTextRenderMatched: true },
    limitations: ['Only one full-page target.', 'Not region redaction.', 'Not whole-document sanitization.'],
  }), {
    ready: true, rasterAvailable: true, redactionPlanReady: false,
    redactionPlanReportReady: false, fullPageRedactionReady: true,
  });
  assert.match(enabled, /data-action="create-full-page-object-redaction" >Create closed full-page redaction copy/);
  assert.match(enabled, /not region redaction or whole-document sanitization/i);
  assert.match(enabled, /Object-level full-page redaction PDF created/);
  assert.match(enabled, /Not region redaction/);
});
