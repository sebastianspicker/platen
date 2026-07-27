import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAccessibilityAltText,
  validAccessibilityAltText,
} from '../src/core/accessibility-alt-text-contract.js';
import { deriveEditorReadiness } from '../src/ui/editor-readiness.js';
import { editorView } from '../src/ui/editor-view.js';
import { state as viewState } from './support/view-render-fixture.js';

const sourceSha256 = 'a'.repeat(64);
const locator = 'b'.repeat(64);

function state(overrides = {}) {
  const analysis = {
    status: 'ready', documentId: 'doc', sha256: sourceSha256,
    inspection: { pageCount: 1 }, structure: null,
    textPages: [], thumbnails: [], fonts: [], images: [], attachments: [],
    signatures: { status: 'unsigned', count: 0, signatureCount: 0 },
  };
  return viewState({
    document: {
      isOpen: true, name: 'images.pdf', size: 4096, type: 'application/pdf',
      objectUrl: 'blob:images', modified: false,
    },
    host: { status: 'ready', accessibilityRemediationReady: true, engines: [] },
    analysis,
    accessibilityAltTextCandidateLocator: locator,
    accessibilityAltText: 'A red door beside a ramp.',
    accessibilityAltTextProposalResult: null,
    accessibilityReviewResult: {
      kind: 'accessibility-review', status: 'review-required', sourceDigest: sourceSha256,
      profile: { id: 'basic-local-review' }, checks: [], counts: {},
      remediationPlan: {
        truncated: false, candidateCount: 1,
        candidates: [{
          action: 'author-image-alt-text', status: 'proposed-not-applied',
          reason: 'Alternative text requires human authorship and validation.',
          target: { page: 1, imageNumber: 0, locator },
        }],
      },
    },
    ...overrides,
  });
}

test('alt-text contract canonicalizes bounded human text and rejects unsafe strings', () => {
  assert.equal(normalizeAccessibilityAltText('  Cafe\u0301 entrance  '), 'Caf\u00e9 entrance');
  assert.equal(validAccessibilityAltText('A useful description.'), true);
  for (const invalid of [
    '', ' '.repeat(4), 'line\nbreak', `hidden\u202etext`, '\u00adsoft', '\u061calm',
    '\ud800', '\udc00', '/path-like', '../path-like', 'C:\\path-like', 'x'.repeat(1001),
  ]) {
    assert.equal(normalizeAccessibilityAltText(invalid), null);
  }
  assert.equal(validAccessibilityAltText('😀'.repeat(500)), true);
  assert.equal(validAccessibilityAltText('😀'.repeat(501)), false);
});

test('alt-text UI requires one current trusted image candidate and authored text', () => {
  const eligible = state();
  const readiness = deriveEditorReadiness(eligible, eligible.analysis);
  assert.equal(readiness.accessibilityAltTextEditorReady, true);
  assert.equal(readiness.accessibilityAltTextReady, true);
  const html = editorView(eligible);
  assert.match(html, /id="accessibility-alt-text-candidate"/u);
  assert.match(html, /data-action="create-accessibility-alt-text-proposal" >/u);
  assert.match(html, /authored text is stored in the downloaded proposal JSON/u);
  assert.match(html, /not inferred from image content/u);

  const stale = state();
  stale.accessibilityReviewResult.sourceDigest = 'c'.repeat(64);
  assert.equal(deriveEditorReadiness(stale, stale.analysis).accessibilityAltTextReady, false);
  const unknown = state({ accessibilityAltTextCandidateLocator: 'd'.repeat(64) });
  assert.equal(deriveEditorReadiness(unknown, unknown.analysis).accessibilityAltTextReady, false);
  const unsafe = state({ accessibilityAltText: 'unsafe\u202etext' });
  assert.equal(deriveEditorReadiness(unsafe, unsafe.analysis).accessibilityAltTextReady, false);
  const busy = state({ busyAction: 'Creating proposal…' });
  const busyReadiness = deriveEditorReadiness(busy, busy.analysis);
  assert.equal(busyReadiness.accessibilityAltTextEditorReady, false);
  assert.equal(busyReadiness.accessibilityAltTextReady, false);
});

test('alt-text UI escapes authored text and shows only non-applying status after export', () => {
  const html = editorView(state({
    accessibilityAltText: '<figure>Entrance</figure>',
    accessibilityAltTextProposalResult: {
      status: 'proposed-not-applied', page: '<1>', imageNumber: '<0>',
    },
  }));
  assert.match(html, /&lt;figure&gt;Entrance&lt;\/figure&gt;/u);
  assert.doesNotMatch(html, /<figure>Entrance<\/figure>/u);
  assert.match(html, /page &lt;1&gt;, image &lt;0&gt;; status proposed-not-applied/u);
});
