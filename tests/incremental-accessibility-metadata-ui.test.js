import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveEditorReadiness } from '../src/ui/editor-readiness.js';
import { editorView } from '../src/ui/editor-view.js';
import { state as viewState } from './support/view-render-fixture.js';

const sourceSha256 = 'a'.repeat(64);

function analysis() {
  return {
    status: 'ready',
    documentId: '11111111-1111-4111-8111-111111111111',
    sha256: sourceSha256,
    inspection: {
      pageCount: 1,
      encrypted: 'no',
      form: 'none',
      javascript: 'no',
      tagged: 'no',
    },
    structure: {
      xmpMetadata: { present: false },
      urls: [],
      pageBoxes: [],
    },
    attachments: [],
    signatures: { status: 'unsigned', signatureCount: 0 },
    textPages: [],
    thumbnails: [],
    fonts: [],
    images: [],
  };
}

function state(overrides = {}) {
  return viewState({
    document: {
      isOpen: true,
      name: 'source.pdf',
      size: 4_096,
      type: 'application/pdf',
      objectUrl: 'blob:source',
      modified: false,
    },
    host: {
      status: 'ready',
      incrementalAccessibilityMetadataReady: true,
      engines: [],
    },
    analysis: analysis(),
    accessibilityDocumentLanguage: 'en-us',
    accessibilityDocumentTitle: 'Accessible source',
    accessibilityReviewResult: {
      kind: 'accessibility-review',
      sourceDigest: sourceSha256,
      checks: [
        { id: 'document-language', status: 'warning', summary: 'Missing.' },
        { id: 'document-title', status: 'warning', summary: 'Missing.' },
      ],
      remediationPlan: {
        truncated: false,
        candidates: [
          { action: 'set-document-language', status: 'proposed-not-applied' },
          { action: 'set-document-title', status: 'proposed-not-applied' },
        ],
      },
    },
    ...overrides,
  });
}

test('accessibility metadata UI requires current missing-value evidence and exact inputs', () => {
  const eligible = state();
  const readiness = deriveEditorReadiness(eligible, eligible.analysis);
  assert.equal(readiness.incrementalAccessibilityMetadataEditorReady, true);
  assert.equal(readiness.incrementalAccessibilityMetadataReady, true);
  const html = editorView(eligible);
  assert.match(html, /data-action="create-accessibility-language-title-copy" >/u);
  assert.match(html, /Prior metadata remains recoverable/u);
  assert.match(html, /not content-item language, tagging, structure repair/u);

  const stale = state();
  stale.accessibilityReviewResult.sourceDigest = 'b'.repeat(64);
  assert.equal(
    deriveEditorReadiness(stale, stale.analysis).incrementalAccessibilityMetadataReady,
    false,
  );
  const invalid = state({ accessibilityDocumentLanguage: 'EN_us' });
  assert.equal(
    deriveEditorReadiness(invalid, invalid.analysis).incrementalAccessibilityMetadataReady,
    false,
  );
});

test('accessibility metadata result escapes artifact text and makes no conformance claim', () => {
  const html = editorView(state({
    incrementalAccessibilityMetadataResult: {
      kind: 'pdf-incremental-accessibility-metadata',
      artifact: { displayName: '<language-title>.pdf' },
    },
  }));
  assert.match(html, /&lt;language-title&gt;\.pdf/u);
  assert.doesNotMatch(html, /<language-title>/u);
  assert.match(html, /no tagging, structure repair, conformance certification/u);
});
