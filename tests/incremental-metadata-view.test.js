import test from 'node:test';
import {
  assert, deriveEditorReadiness, editorView, state,
} from './support/view-render-fixture.js';

function readyState(overrides = {}) {
  return state({
    document: {
      isOpen: true, name: 'local.pdf', size: 4096, type: 'application/pdf',
      objectUrl: 'blob:local', modified: false,
    },
    host: {
      status: 'ready', incrementalMetadataReady: true,
      pdfkitInspectionReady: false, pdfkitMutationReady: false, engines: [],
    },
    analysis: {
      status: 'ready', documentId: 'doc', sha256: 'a'.repeat(64),
      inspection: { pageCount: 1, encrypted: 'no', form: 'none', javascript: 'no' },
      structure: { xmpMetadata: { present: false }, urls: [] },
      textPages: [], thumbnails: [], fonts: [], images: [], attachments: [],
      signatures: { status: 'unsigned', signatureCount: 0 },
    },
    pdfkitMetadata: { title: '<local>', author: '', subject: '', keywords: '' },
    ...overrides,
  });
}

test('incremental metadata UI is available without PDFKit and keeps the fallback explicit', () => {
  const current = readyState();
  assert.equal(deriveEditorReadiness(current, current.analysis).incrementalMetadataReady, true);
  const html = editorView(current);
  assert.match(html, /data-action="create-incremental-metadata-copy" >Create object-preserving PDF/);
  assert.match(html, /data-action="create-pdfkit-metadata-copy" disabled>Create PDFKit-derived fallback/);
  assert.match(html, /Historical metadata therefore remains recoverable/);
  assert.match(html, /value="&lt;local&gt;"/);
  assert.doesNotMatch(html, /value="<local>"/);
});

test('incremental metadata readiness fails closed on XMP or indeterminate signatures', () => {
  const xmp = readyState({
    analysis: {
      ...readyState().analysis,
      structure: { xmpMetadata: { present: true }, urls: [] },
    },
  });
  assert.equal(deriveEditorReadiness(xmp, xmp.analysis).incrementalMetadataReady, false);
  const indeterminate = readyState({
    analysis: {
      ...readyState().analysis,
      signatures: { status: 'indeterminate', signatureCount: null },
    },
  });
  assert.equal(
    deriveEditorReadiness(indeterminate, indeterminate.analysis).incrementalMetadataReady,
    false,
  );
  const noOp = readyState({
    analysis: {
      ...readyState().analysis,
      inspection: { ...readyState().analysis.inspection, title: '<local>' },
    },
  });
  assert.equal(deriveEditorReadiness(noOp, noOp.analysis).incrementalMetadataReady, false);
  const invalidText = readyState({ pdfkitMetadata: {
    title: ' leading', author: '', subject: '', keywords: '',
  } });
  assert.equal(deriveEditorReadiness(invalidText, invalidText.analysis).incrementalMetadataReady, false);
});
