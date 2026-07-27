import test from 'node:test';
import {
  assert,
  deriveEditorReadiness,
  editorView,
  pluginsView,
  prototypeCoverage,
  prototypeRecords,
  prototypeSummary,
  registry,
  state,
} from './support/view-render-fixture.js';

test('editor readiness is an immutable capability snapshot', () => {
  const input = state({
    busyAction: null,
    analysis: { status: 'ready', inspection: { pageCount: 1 }, attachments: [], signatures: { status: 'unsigned', signatureCount: 0 }, structure: { urls: [] } },
    host: { engines: [{ name: 'magick', available: true }, { name: 'gs', available: false }] },
    ocrLanguages: ['eng'],
  });
  const readiness = deriveEditorReadiness(input, input.analysis);
  assert.ok(Object.isFrozen(readiness));
  assert.ok(Object.isFrozen(readiness.ocrLanguages));
  assert.equal(readiness.ready, true);
  assert.equal(readiness.rasterAvailable, true);
  assert.equal(readiness.ghostscriptAvailable, false);
  assert.deepEqual(readiness.ocrLanguages, ['eng']);
  input.ocrLanguages.push('deu');
  assert.deepEqual(readiness.ocrLanguages, ['eng']);
});

test('editor view renders meaningful empty and local-document states', () => {
  const empty = editorView(state());
  assert.match(empty, /Open a local PDF/);
  assert.match(empty, /Ready — no document open/);
  assert.match(empty, /data-action="toggle-controlled-render" aria-pressed="false" disabled/);
  assert.doesNotMatch(empty, /undefined/);

  const open = editorView(state({
    document: { isOpen: true, name: '<unsafe>.pdf', size: 2048, type: 'application/pdf', objectUrl: 'blob:test', modified: false },
  }));
  assert.match(open, /&lt;unsafe&gt;\.pdf/);
  assert.doesNotMatch(open, /<unsafe>/);
  assert.match(open, /zoom-10 rotation-0/);
  assert.match(open, /<object class="native-pdf"/);
  assert.match(open, /data="blob:test#page=1&amp;toolbar=1&amp;navpanes=0"/);
  assert.match(open, /type="application\/pdf"/);
  assert.doesNotMatch(open, /<iframe\b/);
  assert.match(open, /Native PDF preview is unavailable/);
  assert.match(open, /Download original/);

  const transformed = editorView(state({
    zoom: 1.2,
    rotation: 90,
    document: { isOpen: true, name: 'sample.pdf', size: 2048, type: 'application/pdf', objectUrl: 'blob:test', modified: false },
  }));
  assert.match(transformed, /zoom-12 rotation-90/);
});

test('verified raster-burn redaction toggles full-page targeting controls', () => {
  const unchecked = editorView(state());
  assert.match(unchecked, /id="redaction-full-page" type="checkbox"\s*\/> Redact the entire selected page/);
  for (const control of ['redact-x', 'redact-y', 'redact-width', 'redact-height']) {
    assert.doesNotMatch(unchecked, new RegExp(`id="${control}"[^>]*\\sdisabled(?:\\s|=|>)`));
  }

  const checked = editorView(state({ redactionFullPage: true }));
  assert.match(checked, /id="redaction-full-page" type="checkbox" checked \/> Redact the entire selected page/);
  for (const control of ['redact-x', 'redact-y', 'redact-width', 'redact-height']) {
    assert.match(checked, new RegExp(`id="${control}"[^>]*\\sdisabled(?:\\s|=|>)`));
  }
});

test('editor exposes an explicit source-bound proposal picker without stored text', () => {
  const sourceSha256 = 'a'.repeat(64);
  const html = editorView(state({
    document: { isOpen: true, name: 'reviewed.pdf', size: 2048, type: 'application/pdf', objectUrl: 'blob:reviewed', modified: false },
    host: { status: 'ready', redactionPlansReady: true, redactionPlanReportsReady: true, engines: [{ name: 'magick', available: true }] },
    analysis: {
      status: 'ready', documentId: 'doc', sha256: sourceSha256,
      inspection: { pageCount: 1 }, structure: null, textPages: [], thumbnails: [],
      fonts: [], images: [], attachments: [], signatures: { status: 'unsigned', signatureCount: 0 },
    },
    redactionPlans: [{
      id: 'plan-1', type: 'redaction-plan', schemaVersion: 1,
      profile: 'source-bound-redaction-plan-v1', status: 'proposed-not-applied',
      createdAtLocal: '2026-07-19T10:00:00.000Z',
      sourceSha256, coordinateSpace: 'normalized-cropbox-top-left-v1',
      applicationProfile: 'verified-raster-burn-v2', planSha256: 'b'.repeat(64),
      marks: [{ id: 'mark-1', page: 1, region: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 } }],
    }],
    selectedRedactionPlanId: 'plan-1',
    selectedRedactionMarkId: 'mark-1',
  }));
  assert.match(html, /Reviewed proposal bridge/u);
  assert.match(html, /data-action="create-redaction-plan"/u);
  assert.match(html, /data-action="apply-redaction-plan"/u);
  assert.match(html, /data-action="export-redaction-plan-report"/u);
  assert.match(html, /not a redaction certificate or application report/u);
  assert.match(html, /Proposal 1 · 1 mark/u);
  assert.match(html, /Mark 1 · page 1 · region/u);
  assert.match(html, /The proposal remains proposed-not-applied/u);
  assert.doesNotMatch(html, /removedText|textBinding|hmacSha256/u);
});

test('editor view exposes real local analysis, search, thumbnails and resource evidence', () => {
  const html = editorView(state({
    document: { isOpen: true, name: 'analyzed.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:analyzed', modified: false },
    host: { status: 'ready', engines: [{ name: 'pdfinfo', available: true }] },
    analysis: {
      status: 'ready', documentId: 'doc', progress: null,
      inspection: { pageCount: 2, pdfVersion: '1.7', pageSize: '612 x 792 pts', tagged: 'yes', encrypted: 'no', optimized: 'yes' },
      structure: {
        pageBoxes: [{ page: 1, boxes: { cropBox: { width: 576, height: 756 } } }],
        namedDestinations: { items: [{ page: 1, name: 'chapter-one', destination: '[ XYZ 0 792 0 ]' }], truncated: false }, urls: [{ url: 'https://example.test' }],
        xmpMetadata: { present: true }, taggedStructure: { present: true, lines: [{ value: 'Document' }] },
        customMetadata: [{ name: 'Department', value: '<local>' }],
      },
      textPages: [{ page: 1, text: 'needle' }],
      thumbnails: [{ page: 1, url: 'blob:thumbnail' }],
      fonts: [{ name: '<unsafe font>', embedded: 'yes' }], images: [{}],
      attachments: [{ number: 1, name: '<unsafe attachment>.txt' }],
      signatures: {
        status: 'valid', integrityStatus: 'valid', coverageStatus: 'full',
        currentDocumentStatus: 'valid', count: 1, signatureCount: 1,
        signatures: [{
          index: 1, integrity: 'valid', documentCoverage: 'full',
          claimedSigner: { commonName: '<unverified signer>', distinguishedName: null },
          claimedSigningTime: '<unverified time>',
        }],
      },
    },
    selectedPage: 1,
    searchQuery: 'needle',
    searchResults: [{ id: '1:0:0', page: 1, before: '', match: 'needle', after: '' }],
  }));
  assert.match(html, /Extract page/);
  assert.match(html, /Search this PDF/);
  assert.match(html, /<mark>needle<\/mark>/);
  assert.match(html, /Local analysis ready · 2 pages/);
  assert.match(html, /&lt;unsafe font&gt;/);
  assert.match(html, /&lt;unsafe attachment&gt;\.txt/);
  assert.match(html, /Poppler reports valid integrity evidence/);
  assert.match(html, /Poppler reports valid integrity and full current-file coverage/);
  assert.match(html, /Current PDF signature state is indeterminate/);
  assert.match(html, /Exact CMS cross-check unavailable/);
  assert.doesNotMatch(html, /Integrity intact and current PDF fully covered/);
  assert.match(html, /Full document/);
  assert.match(html, /Claimed signer 1 \(unverified\)/);
  assert.match(html, /&lt;unverified signer&gt;/);
  assert.match(html, /certificate trust, signer identity, revocation, or timestamps/i);
  assert.match(html, /Native structure evidence/);
  assert.match(html, /Selected CropBox/);
  assert.match(html, /&lt;local&gt;/);
  assert.doesNotMatch(html, /<unsafe font>/);
  assert.doesNotMatch(html, /<unsafe attachment>/);
  assert.match(html, /browser-controlled/);
  for (const action of ['split-document', 'split-by-rule', 'duplicate-page', 'reverse-pages', 'choose-interleave-file', 'choose-insert-file', 'choose-replace-file', 'choose-copy-page-file', 'choose-scan-page-file']) {
    assert.match(html, new RegExp(`data-action="${action}"`));
  }
  for (const picker of ['interleave-picker', 'insert-picker', 'replace-picker', 'copy-page-picker', 'scan-append-picker']) {
    assert.match(html, new RegExp(`id="${picker}"`));
  }
  assert.match(html, /id="copy-source-page"[^>]*min="1"[^>]*max="100"/);
  assert.match(html, /does not preserve document-level structures, signatures, object identity, or original bytes/i);

  const thumbnailHtml = editorView(state({
    document: { isOpen: true, name: 'analyzed.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:analyzed', modified: false },
    analysis: {
      status: 'ready', documentId: 'doc', progress: null,
      inspection: { pageCount: 1 }, textPages: [{ page: 1, text: 'needle' }],
      thumbnails: [{ page: 1, url: 'blob:thumbnail' }], fonts: [], images: [], attachments: [], signatures: { count: 0 },
    },
    selectedPage: 1,
  }));
  assert.match(thumbnailHtml, /blob:thumbnail/);

  const boundedFailure = editorView(state({
    document: { isOpen: true, name: 'oversized.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:oversized', modified: false },
    analysis: {
      status: 'ready', documentId: 'doc', progress: null, inspection: { pageCount: 1 },
      textPages: [], thumbnails: [], thumbnailNotice: 'Page geometry exceeds the render limit.',
      fonts: [], images: [], attachments: [], signatures: { count: 0 },
    },
  }));
  assert.match(boundedFailure, /Page geometry exceeds the render limit/);

  const cancellable = editorView(state({ busyAction: 'Creating OCR copy…', canCancel: true }));
  assert.match(cancellable, /data-action="cancel-operation"/);
});

test('editor renders the Poppler destination inventory without optional PDFKit and bounds it to page navigation', () => {
  const html = editorView(state({
    document: { isOpen: true, name: 'destinations.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:destinations', modified: false },
    host: { status: 'ready', pdfkitInspectionReady: false, engines: [{ name: 'pdfinfo', available: true }] },
    analysis: {
      status: 'ready', documentId: 'doc', inspection: { pageCount: 2 }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 },
      structure: { pageCount: 2, namedDestinations: { items: Array.from({ length: 21 }, (_, index) => ({ page: (index % 2) + 1, name: `<destination-${index}>`, destination: '[ XYZ 0 792 0 ]' })), truncated: true } },
    },
  }));
  assert.match(html, /Named destinations/);
  assert.match(html, /data-page-number="1"/);
  assert.match(html, /&lt;destination-0&gt;/);
  assert.doesNotMatch(html, /<destination-0>/);
  assert.match(html, /retained at 200 records and only the first 20 are shown/);
  assert.match(html, /Inventory limit: page-level navigation only\. This read-only inventory does not expose coordinates, zoom, actions, destination lookup, or authoring/);
  assert.doesNotMatch(html, /destination-20/);
  const empty = editorView(state({
    analysis: { status: 'ready', inspection: { pageCount: 1 }, structure: { pageCount: 1, namedDestinations: { items: [], truncated: false } }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 } },
  }));
  assert.match(empty, /No named destinations were reported/);
  assert.match(editorView(state()), /Unavailable until local Poppler structure inspection completes/);
  const unresolved = editorView(state({
    analysis: { status: 'ready', inspection: { pageCount: 2 }, structure: { pageCount: 1, namedDestinations: { items: [{ page: 2, name: 'out-of-range', destination: '[ XYZ ]' }], truncated: false } }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 } },
  }));
  assert.match(unresolved, /out-of-range · unresolved page/);
  assert.doesNotMatch(unresolved, /data-page-number="2"/);
  for (const pageCount of ['2', Infinity, null]) {
    const invalidBound = editorView(state({
      analysis: { status: 'ready', inspection: { pageCount: 2 }, structure: { pageCount, namedDestinations: { items: [{ page: 1, name: 'inert', destination: '[ XYZ ]' }], truncated: false } }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 } },
    }));
    assert.match(invalidBound, /inert · unresolved page/);
    assert.doesNotMatch(invalidBound, /data-page-number="1"/);
  }
  const primitiveItems = editorView(state({
    analysis: { status: 'ready', inspection: { pageCount: 1 }, structure: { pageCount: 1, namedDestinations: { items: [null, 7, 'text'], truncated: false } }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 } },
  }));
  assert.match(primitiveItems, /Unnamed destination · unresolved page/);
  assert.doesNotMatch(primitiveItems, /data-page-number=/);
  assert.doesNotThrow(() => editorView(state({ analysis: { status: 'ready', inspection: { pageCount: 1 }, structure: 7, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 } } })));
});

test('editor view distinguishes intact prior-revision coverage from current-document validity', () => {
  const html = editorView(state({
    document: { isOpen: true, name: 'updated-after-signing.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:signed', modified: false },
    host: { status: 'ready', engines: [] },
    analysis: {
      status: 'ready', documentId: 'doc',
      inspection: { pageCount: 1 }, structure: null,
      textPages: [], thumbnails: [], fonts: [], images: [], attachments: [],
      signatures: {
        status: 'valid', integrityStatus: 'valid', coverageStatus: 'prior-revision',
        currentDocumentStatus: 'modified-after-signing', count: 1, signatureCount: 1,
        signatures: [{
          index: 1, integrity: 'valid', documentCoverage: 'prior-revision',
          claimedSigner: { commonName: 'Unverified local claim', distinguishedName: null },
        }],
      },
    },
  }));
  assert.match(html, /Poppler reports an intact covered revision with later uncovered PDF bytes/);
  assert.match(html, /Current PDF signature state is indeterminate/);
  assert.match(html, /Prior revision only/);
  assert.match(html, /certificate trust, signer identity, revocation, or timestamps/i);
  assert.doesNotMatch(html, /certificate (?:is )?(?:valid|trusted)/i);
});

test('editor view keeps macOS certificate-path evidence separate from signature integrity and identity', () => {
  const html = editorView(state({
    document: { isOpen: true, name: 'chain-evidence.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:chain', modified: false },
    host: { status: 'ready', engines: [] },
    analysis: {
      status: 'ready', documentId: 'doc', inspection: { pageCount: 1 }, structure: null,
      textPages: [], thumbnails: [], fonts: [], images: [], attachments: [],
      signatures: {
        schemaVersion: 2,
        status: 'invalid', integrityStatus: 'invalid', coverageStatus: 'full',
        currentDocumentStatus: 'invalid', count: 1, signatureCount: 1,
        certificateChainSummary: 'all-pass',
        certificateEvaluation: {
          profile: 'macos-basic-x509-current-trust-v2',
          evaluatedAt: '2026-07-19T10:00:00.000Z',
          verificationTimeBasis: 'host-current-time',
          anchorBasis: 'current-macos-trust-configuration',
          certificateNetworkFetchAllowed: false,
        },
        signatures: [{
          index: 1, integrity: 'invalid', documentCoverage: 'full',
          claimedSigner: { commonName: '<unverified path claim>', distinguishedName: null },
          certificateChain: { status: 'passes', reason: 'none', chainLength: 3 },
        }],
      },
    },
  }));
  assert.match(html, /Embedded signature integrity failed/);
  assert.match(html, /Passed macOS Basic X\.509 path evaluation/);
  assert.match(html, /3 certificates in evaluated path/);
  assert.match(html, /This Mac’s current trust configuration/);
  assert.match(html, /Certificate fetching/);
  assert.match(html, /Disabled/);
  assert.match(html, /do not establish signer identity/);
  assert.match(html, /&lt;unverified path claim&gt;/);
  assert.doesNotMatch(html, /trusted signer|identity verified|not revoked/i);
});

test('editor makes an exact CMS disagreement the overall conclusion and prioritizes a fifth negative record', () => {
  const signatures = Array.from({ length: 5 }, (_, index) => ({
    index: index + 1,
    integrity: 'valid',
    documentCoverage: 'full',
    claimedSigner: { commonName: `Unverified ${index + 1}`, distinguishedName: null },
    certificateChain: index === 4
      ? { status: 'indeterminate', reason: 'cms-signature-mismatch', chainLength: null }
      : { status: 'passes', reason: 'none', chainLength: 2 },
  }));
  const html = editorView(state({
    document: { isOpen: true, name: 'cms-disagreement.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:cms', modified: false },
    host: { status: 'ready', engines: [] },
    analysis: {
      status: 'ready', documentId: 'doc', inspection: { pageCount: 1 }, structure: null,
      textPages: [], thumbnails: [], fonts: [], images: [], attachments: [],
      signatures: {
        schemaVersion: 2,
        status: 'valid', currentDocumentStatus: 'valid', count: 5, signatureCount: 5,
        popplerEvidence: {
          engine: 'Poppler pdfsig', integrityStatus: 'valid', currentDocumentStatus: 'valid',
        },
        cmsCrossCheck: {
          status: 'indeterminate', verifiedCount: 4, indeterminateCount: 1,
          unsupportedCount: 0, reasons: ['cms-signature-mismatch'],
        },
        overallCurrentDocumentStatus: 'valid',
        certificateChainSummary: 'indeterminate',
        certificateEvaluation: {
          profile: 'macos-basic-x509-current-trust-v2',
          evaluatedAt: '2026-07-19T10:00:00.000Z',
          verificationTimeBasis: 'host-current-time',
          anchorBasis: 'current-macos-trust-configuration',
          certificateNetworkFetchAllowed: false,
        },
        signatures,
      },
    },
  }));

  assert.match(html, /Overall signature conclusion/);
  assert.match(html, /Current PDF signature state is indeterminate/);
  assert.match(html, /Exact CMS cross-check/);
  assert.match(html, /4 verified · 1 indeterminate · 0 unsupported/);
  assert.match(html, /Signature 5 certificate path/);
  assert.match(html, /Exact CMS did not verify against the declared signed byte ranges/);
  assert.match(html, /Showing 4 prioritized signature records; 1 additional record is omitted/);
  assert.doesNotMatch(html, /Integrity intact and current PDF fully covered/);
});

test('editor view exposes a bounded local CropBox snapshot with honest clipboard gating', () => {
  const readyState = {
    document: { isOpen: true, name: 'snapshot.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:snapshot', modified: false },
    host: { status: 'ready', engines: [{ name: 'pdftocairo', available: true }] },
    analysis: {
      status: 'ready', documentId: 'doc', inspection: { pageCount: 1, form: 'none' }, structure: null,
      textPages: [], thumbnails: [], fonts: [], images: [], attachments: [],
      signatures: { status: 'unsigned', count: 0, signatureCount: 0 },
    },
    selectedPage: 1,
    snapshotRegion: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    snapshotDpi: '192',
  };
  const enabled = editorView(state({ ...readyState, snapshotClipboardReady: true }));
  assert.match(enabled, /Rendered region snapshot/);
  assert.match(enabled, /top-left of the passive CropBox raster/);
  assert.match(enabled, /floor for left\/top and ceil for right\/bottom pixel edges/);
  assert.match(enabled, /data-action="copy-page-snapshot" >Copy PNG/);
  assert.match(enabled, /data-action="download-page-snapshot" >Download PNG/);
  assert.match(enabled, /Selectable text, vectors, links, tags, layers, forms, and PDF object structure are not present/);

  const unavailable = editorView(state({ ...readyState, snapshotClipboardReady: false }));
  assert.match(unavailable, /data-action="copy-page-snapshot" disabled>Copy PNG/);
  assert.match(unavailable, /data-action="download-page-snapshot" >Download PNG/);
  assert.match(unavailable, /clipboard writing is unavailable/);

  const invalid = editorView(state({
    ...readyState, snapshotClipboardReady: true,
    snapshotRegion: { x: 0.8, y: 0, width: 0.3, height: 1 },
  }));
  assert.match(invalid, /data-action="copy-page-snapshot" disabled>Copy PNG/);
  assert.match(invalid, /data-action="download-page-snapshot" disabled>Download PNG/);
});
