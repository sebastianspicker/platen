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

test('persistent CropBox controls require unsigned changed in-MediaBox geometry and disclose reveal risk', () => {
  const base = {
    document: { isOpen: true, name: 'crop.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:crop', modified: false },
    host: { status: 'ready', pdfkitMutationReady: true, engines: [] },
    analysis: {
      status: 'ready', documentId: 'doc', sha256: 'a'.repeat(64),
      inspection: { pageCount: 1, form: 'none' }, structure: {},
      textPages: [], thumbnails: [], fonts: [], images: [], attachments: [],
      signatures: { status: 'unsigned', count: 0, signatureCount: 0 },
    },
    selectedPage: 1,
    pdfkitPageBox: 'crop',
    pdfkitInspectionResult: {
      sourceDigest: 'a'.repeat(64), pageCount: 1,
      pages: [{
        index: 1, rotation: 0,
        boxes: {
          media: { x: 0, y: 0, width: 612, height: 792 },
          crop: { x: 0, y: 0, width: 612, height: 792 },
        },
        annotations: [], annotationsTruncated: false, widgets: [],
      }],
    },
  };
  const ready = editorView(state({
    ...base, pdfkitPageBoxRect: { x: 12, y: 18, width: 560, height: 740 },
  }));
  assert.match(ready, /data-action="create-pdfkit-pagebox-copy" >Create PDFKit cropped fallback/);
  assert.match(ready, /bounded annotation subtype, geometry, flags, contents digest/);
  assert.match(ready, /Private contents and descriptor hashes never leave the helper/);
  assert.match(ready, /Poppler independently confirms the exact output box/);
  assert.match(ready, /Expanding the CropBox can reveal source content/);

  const noOp = editorView(state({
    ...base, pdfkitPageBoxRect: { x: 0, y: 0, width: 612, height: 792 },
  }));
  assert.match(noOp, /data-action="create-pdfkit-pagebox-copy" disabled>Create PDFKit cropped fallback/);

  const outside = editorView(state({
    ...base, pdfkitPageBoxRect: { x: 600, y: 0, width: 20, height: 100 },
  }));
  assert.match(outside, /data-action="create-pdfkit-pagebox-copy" disabled>Create PDFKit cropped fallback/);

  const signed = editorView(state({
    ...base,
    analysis: {
      ...base.analysis,
      signatures: { status: 'valid', count: 1, signatureCount: 1 },
    },
    pdfkitPageBoxRect: { x: 12, y: 18, width: 560, height: 740 },
  }));
  assert.match(signed, /data-action="create-pdfkit-pagebox-copy" disabled>Create PDFKit cropped fallback/);

  const bleedBase = {
    ...base,
    pdfkitPageBox: 'bleed',
    pdfkitInspectionResult: {
      ...base.pdfkitInspectionResult,
      pages: [{
        ...base.pdfkitInspectionResult.pages[0],
        boxes: {
          ...base.pdfkitInspectionResult.pages[0].boxes,
          bleed: { x: 0, y: 0, width: 612, height: 792 },
          trim: { x: 20, y: 20, width: 572, height: 752 },
        },
      }],
    },
  };
  const bleedReady = editorView(state({
    ...bleedBase, pdfkitPageBoxRect: { x: 10, y: 10, width: 592, height: 772 },
  }));
  assert.match(bleedReady, /data-action="create-pdfkit-pagebox-copy" >Create PDFKit BleedBox fallback/);
  assert.match(bleedReady, /BleedBox must also contain the unchanged TrimBox/);
  assert.match(bleedReady, /Explicit-versus-inherited box syntax is not preserved/);

  const bleedNoOp = editorView(state({
    ...bleedBase, pdfkitPageBoxRect: { x: 0, y: 0, width: 612, height: 792 },
  }));
  assert.match(bleedNoOp, /data-action="create-pdfkit-pagebox-copy" disabled>Create PDFKit BleedBox fallback/);

  const bleedExcludesTrim = editorView(state({
    ...bleedBase, pdfkitPageBoxRect: { x: 30, y: 30, width: 552, height: 732 },
  }));
  assert.match(bleedExcludesTrim, /data-action="create-pdfkit-pagebox-copy" disabled>Create PDFKit BleedBox fallback/);
});

test('editor exposes fixed local PDFKit protection without rendering or retaining passwords', () => {
  const html = editorView(state({
    document: { isOpen: true, name: 'protect.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:protect', modified: false },
    host: { status: 'ready', pdfkitProtectionReady: true, engines: [] },
    analysis: {
      status: 'ready', documentId: 'doc', sha256: 'a'.repeat(64),
      inspection: {
        pageCount: 2, encrypted: 'no', form: 'none', javascript: 'no', tagged: 'no',
      },
      structure: { urls: [] }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [],
      signatures: {
        status: 'unsigned', count: 0, signatureCount: 0, signatures: [],
        raw: "File '/private/local-protect.pdf' does not contain any signatures",
      },
    },
    pdfkitUserPassword: '<must-not-render-open-password>',
    pdfkitOwnerPassword: '<must-not-render-owner-password>',
    pdfkitProtectionResult: {
      kind: 'pdfkit-password-protection',
      artifact: {
        id: '12345678-1234-4123-8123-123456789abc',
        sha256: 'c'.repeat(64),
        displayName: '<protected>.pdf',
      },
      protection: {
        cipher: 'AES-128-CBC', permissionsProfile: 'accessibility-only',
        effectivePermissions: ['contentAccessibility'],
      },
      limitations: ['Permissions remain <advisory>.'],
    },
    pdfkitProtectionRemovalResult: {
      kind: 'pdfkit-protection-removal',
      artifact: { displayName: '<cleartext>.pdf' },
      protection: { ownerAuthorizationVerified: true, encrypted: false },
      limitations: ['The protected <artifact> remains retained.'],
    },
  }));
  assert.match(html, /Password protection/);
  assert.match(html, /data-action="create-pdfkit-protected-copy" >/);
  assert.match(html, /Allow accessibility extraction only/);
  assert.match(html, /Allow copying and accessibility extraction/);
  assert.match(html, /Allow printing only/);
  assert.match(html, /Deny all optional operations/);
  assert.match(html, /four fixed presets/);
  assert.match(html, /same-origin loopback HTTP boundary as bounded JSON/);
  assert.match(html, /developer tools, network instrumentation/);
  for (const id of [
    'pdfkit-user-password', 'pdfkit-user-password-confirmation',
    'pdfkit-owner-password', 'pdfkit-owner-password-confirmation',
  ]) {
    assert.match(html, new RegExp(`id="${id}" type="password"[^>]+autocomplete="new-password"`));
    assert.doesNotMatch(html, new RegExp(`id="${id}"[^>]+value=`));
  }
  assert.match(html, /id="pdfkit-user-password"[^>]+maxlength="16"/);
  assert.match(html, /id="pdfkit-owner-password"[^>]+maxlength="32"/);
  assert.match(html, /measured PDFKit owner-classification defect/);
  assert.match(html, /Password-protected PDF created/);
  assert.match(html, /&lt;protected&gt;\.pdf/);
  assert.match(html, /Permissions remain &lt;advisory&gt;/);
  assert.match(html, /Remove protection from this retained copy/);
  assert.match(html, /data-action="remove-pdfkit-protection" >/);
  for (const id of ['pdfkit-remove-owner-password', 'pdfkit-remove-owner-password-confirmation']) {
    assert.match(html, new RegExp(`id="${id}" type="password"[^>]+minlength="12"[^>]+maxlength="32"[^>]+autocomplete="new-password"`));
    assert.doesNotMatch(html, new RegExp(`id="${id}"[^>]+value=`));
  }
  assert.match(html, /exact protected artifact created in this local session/);
  assert.match(html, /technical authorization check, not proof of legal ownership/);
  assert.match(html, /cleartext artifact as ephemeral and deletes it after the one download transfer/);
  assert.match(html, /Separate unencrypted PDF created/);
  assert.match(html, /&lt;cleartext&gt;\.pdf/);
  assert.match(html, /protected &lt;artifact&gt; remains retained/);
  assert.doesNotMatch(html, /must-not-render|<protected>|<advisory>|<cleartext>|<artifact>/);
  assert.doesNotMatch(html, /local-protect\.pdf|\/private\//);

  const unavailable = editorView(state({
    document: { isOpen: true, name: 'tagged.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:tagged', modified: false },
    host: { status: 'ready', pdfkitProtectionReady: true, engines: [] },
    analysis: {
      status: 'ready', documentId: 'doc', sha256: 'b'.repeat(64),
      inspection: { pageCount: 1, encrypted: 'no', form: 'none', javascript: 'no', tagged: 'yes' },
      structure: { urls: [] }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [],
      signatures: { status: 'unsigned', count: 0, signatureCount: 0, signatures: [] },
    },
  }));
  assert.match(unavailable, /data-action="create-pdfkit-protected-copy" disabled/);
  assert.match(unavailable, /does not meet every fixed protection precondition/);
  assert.doesNotMatch(unavailable, /data-action="remove-pdfkit-protection"/);
});

test('editor exposes only the fixed verified metadata-sanitization subset', () => {
  const base = {
    document: {
      isOpen: true, name: 'metadata.pdf', size: 4096, type: 'application/pdf',
      objectUrl: 'blob:metadata', modified: false,
    },
    host: { status: 'ready', pdfkitSanitizationReady: true, engines: [] },
    analysis: {
      status: 'ready', documentId: 'doc', sha256: 'a'.repeat(64),
      inspection: {
        pageCount: 2, encrypted: 'no', form: 'none', javascript: 'no', tagged: 'no',
      },
      structure: { urls: [] },
      textPages: [], thumbnails: [], fonts: [], images: [], attachments: [],
      signatures: { status: 'unsigned', count: 0, signatureCount: 0, signatures: [] },
    },
    pdfkitSanitizationResult: {
      kind: 'pdfkit-metadata-sanitization',
      artifact: { displayName: '<metadata-free>.pdf' },
      sanitization: { removedCategories: ['document-info', 'custom-info', 'xmp'] },
      limitations: ['Not <hidden-data> cleanup.'],
    },
  };
  const html = editorView(state(base));
  assert.match(html, /Metadata sanitization/);
  assert.match(html, /data-action="sanitize-pdfkit-metadata" >/);
  assert.match(html, /document Info fields, custom Info fields, and catalog XMP/);
  assert.match(html, /compares page count, geometry, rotations, passive annotations/);
  assert.match(html, /does not remove visible content, comments, hidden objects, orphan bytes, prior revisions/);
  assert.match(html, /Metadata-sanitized PDF created/);
  assert.match(html, /Native bounded content snapshot matched/);
  assert.match(html, /Poppler independently confirmed metadata absence and rendered every output page/);
  assert.doesNotMatch(html, /preserved visible content independently checked/);
  assert.match(html, /&lt;metadata-free&gt;\.pdf/);
  assert.match(html, /document-info, custom-info, xmp/);
  assert.match(html, /Not &lt;hidden-data&gt; cleanup/);
  assert.doesNotMatch(html, /<metadata-free>|<hidden-data>/);

  const rejectedSource = editorView(state({
    ...base,
    analysis: {
      ...base.analysis,
      inspection: { ...base.analysis.inspection, tagged: 'yes' },
    },
    pdfkitSanitizationResult: null,
  }));
  assert.match(rejectedSource, /data-action="sanitize-pdfkit-metadata" disabled/);
  assert.match(rejectedSource, /does not meet every fixed metadata-sanitization precondition/);

  const unavailable = editorView(state({
    ...base,
    host: { status: 'ready', pdfkitSanitizationReady: false, engines: [] },
    pdfkitSanitizationResult: null,
  }));
  assert.match(unavailable, /data-action="sanitize-pdfkit-metadata" disabled/);
  assert.match(unavailable, /enable verified local metadata sanitization on macOS/);
});

test('editor exposes local OCR cleanup, region analysis, and review-only layout exports', () => {
  const html = editorView(state({
    document: { isOpen: true, name: 'scan.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:scan', modified: false },
    host: { status: 'ready', engines: [{ name: 'tesseract', available: true }, { name: 'magick', available: true }] },
    analysis: {
      status: 'ready', documentId: 'doc', progress: null, inspection: { pageCount: 1 },
      textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 },
    },
    selectedPage: 1,
    ocrLanguages: ['eng'],
    ocrLanguage: 'eng',
    ocrCleanupPreset: 'document',
    ocrSegmentation: 'block',
    ocrDetectTables: true,
    ocrResult: {
      language: 'eng', cleanupPreset: 'document', segmentation: 'block', pageCount: 1,
      recognizedWordCount: 1,
      userDictionary: { termCount: 3, digest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
      suspects: [{
        page: 1, text: '<img src=x onerror=alert(1)>', confidence: 47,
        left: 12, top: 24, width: 30, height: 14,
      }],
    },
    ocrSuspectReviewStates: ['false-positive'],
    ocrZones: [{ id: 'zone-1', type: 'table', page: 1, x: 0.1, y: 0.2, width: 0.5, height: 0.25 }],
    selectedOcrZoneId: 'zone-1',
    selectedOcrRecordIndex: 0,
    selectedOcrTableCandidate: 0,
    ocrLayoutResult: {
      kind: 'ocr-layout-analysis', language: 'eng', detectTables: true,
      limitations: ['Geometry only; <review>.'],
      records: [{
        page: 1, zoneId: 'selected-region', recognizedWordCount: 1,
        layout: { words: [{ text: '<script>unsafe</script>', confidence: 91, bounds: { x: 0.1, y: 0.2, width: 0.1, height: 0.03 } }] },
        tableCandidates: [{ alignmentScore: 0.875, reviewRequired: true, truncated: true, grid: [[{ text: 'A' }, { text: 'B' }], [{ text: 'C' }, { text: 'D' }]] }],
        alto: { mediaType: 'application/alto+xml', encoding: 'base64', byteLength: 7, data: 'PGFsdG8+' },
      }],
    },
  }));
  for (const action of ['create-ocr-copy', 'ocr-screenshot-capture', 'add-ocr-zone', 'remove-ocr-zone', 'analyze-ocr-page', 'export-ocr-layout-json', 'export-ocr-layout-html', 'export-ocr-layout-alto', 'export-ocr-table-csv', 'run-ocr-batch', 'export-ocr-suspect-review']) {
    assert.match(html, new RegExp(`data-action="${action}"`));
  }
  for (const control of ['ocr-cleanup-preset', 'ocr-segmentation', 'ocr-user-dictionary', 'ocr-detect-tables', 'ocr-zone-select', 'ocr-zone-type', 'ocr-zone-x', 'ocr-zone-y', 'ocr-zone-width', 'ocr-zone-height', 'ocr-result-record', 'ocr-table-candidate', 'ocr-batch-picker']) {
    assert.match(html, new RegExp(`id="${control}"`));
  }
  assert.match(html, /Every candidate requires human review/);
  assert.match(html, /neutralizes spreadsheet formula prefixes/);
  assert.match(html, /best alignment score 87\.5%/);
  assert.match(html, /1 bounded\/truncated/);
  assert.match(html, /3 user dictionary terms/);
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.match(html, /Geometry only; &lt;review&gt;\./);
  assert.match(html, /Review OCR suspects · 1\/1 classified/);
  assert.match(html, /OCR pixel geometry/);
  assert.match(html, /value="false-positive" selected/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /does not correct recognized text, draw source-page boxes, change the searchable OCR PDF/);
  assert.doesNotMatch(html, /0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/);
  assert.doesNotMatch(html, /<script>unsafe<\/script>/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
});
