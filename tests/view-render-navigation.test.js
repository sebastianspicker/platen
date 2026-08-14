import test from 'node:test';
import {
  assert,
  deriveEditorReadiness,
  editorView,
  pluginsView,
  prototypeCoverage,
  prototypeRecords,
  prototypeSummary,
  readCssSources,
  registry,
  state,
} from './support/view-render-fixture.js';

const SOURCE_ID = '123e4567-e89b-42d3-a456-426614174000';
const SOURCE_SHA256 = 'a'.repeat(64);

test('loupe keeps the native full-page context and exposes bounded accessible states', () => {
  const base = {
    document: { isOpen: true, name: 'loupe.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:source', modified: false },
    host: { status: 'ready', engines: [{ name: 'pdftocairo', available: true }] },
    analysis: {
      status: 'ready', documentId: SOURCE_ID, sha256: SOURCE_SHA256, inspection: { pageCount: 1, form: 'none' }, structure: null,
      textPages: [], thumbnails: [], fonts: [], images: [], attachments: [],
      signatures: { status: 'unsigned', count: 0, signatureCount: 0 },
    },
    selectedPage: 1,
    viewerMode: 'native',
    snapshotRegion: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    snapshotDpi: '192',
  };
  const ready = editorView(state({
    ...base,
    loupeRaster: { status: 'ready', page: 1, dpi: 240, url: 'blob:<loupe>', error: null },
  }));
  assert.match(ready, /data-action="refresh-loupe" >Refresh magnified region/);
  assert.match(ready, /<object class="native-pdf"/);
  assert.match(ready, /Magnified passive raster region for page 1/);
  assert.match(ready, /src="blob:&lt;loupe&gt;"/);
  assert.match(ready, /fixed 240 DPI/);
  assert.match(ready, /not selectable text or vector, link, tag, form, layer, or PDF-object inspection/);
  assert.doesNotMatch(ready, /src="blob:<loupe>"/);

  const loading = editorView(state({
    ...base, loupeRaster: { status: 'loading', page: 1, dpi: 240, url: null, error: null },
  }));
  assert.match(loading, /role="status"[^>]*><span class="spinner"><\/span><span>Rendering magnified raster region/);
  const failed = editorView(state({
    ...base, loupeRaster: { status: 'error', page: 1, dpi: 240, url: null, error: '<failed loupe>' },
  }));
  assert.match(failed, /role="alert"/);
  assert.match(failed, /&lt;failed loupe&gt;/);
  assert.doesNotMatch(failed, /<failed loupe>/);

  const reflow = editorView(state({ ...base, viewerMode: 'reflow' }));
  assert.match(reflow, /data-action="refresh-loupe" disabled>Refresh magnified region/);
  assert.match(reflow, /Return to the native preview to retain full-page context/);
});

test('editor proof desk keeps source evidence, page switching, and inspector groups reachable', () => {
  const empty = editorView(state());
  assert.match(empty, /class="paper empty-paper"/);
  assert.match(empty, /class="paper-frame paper-frame-empty"/);
  assert.doesNotMatch(empty, /aria-label="Preview controls"/);
  assert.match(empty, /data-action="open-file"/);
  assert.match(empty, /data-action="create-blank-document"/);
  assert.match(empty, /Immutable local copy/);
  assert.match(empty, /<details class="inspector-group" open>/);
  assert.match(empty, /<summary>Document <span>Source and evidence<\/span><\/summary>/);
  assert.match(empty, /<summary>Create <span>Derived files and page operations<\/span><\/summary>/);
  assert.doesNotMatch(empty, /<details class="inspector-group" open>\s*<summary>Create/u);

  const ready = editorView(state({
    document: { isOpen: true, name: 'proof.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:proof', modified: false },
    analysis: {
      status: 'ready', documentId: SOURCE_ID, sha256: SOURCE_SHA256, inspection: { pageCount: 3 },
      textPages: [{ page: 1, text: 'one' }], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 },
    },
    selectedPage: 2,
    viewerMode: 'controlled',
    showGrid: true,
    documentTabs: { tabs: [{ id: 'tab-1', name: 'proof.pdf', status: 'ready' }], activeTabId: 'tab-1' },
  }));
  assert.match(ready, /Source<\/span><strong>Immutable · local/);
  assert.match(ready, /Analysis<\/span><strong>Analysis ready/);
  assert.match(ready, /Page<\/span><strong>2 \/ 3/);
  assert.match(ready, /Preview<\/span><strong>Safe raster/);
  assert.match(ready, /class="page-switcher"/);
  assert.match(ready, /data-page-direction="previous" data-page-number="1"[^>]+aria-label="Show previous page"/);
  assert.match(ready, /data-page-direction="next" data-page-number="3"[^>]+aria-label="Show next page"/);
  assert.match(ready, /data-action="toggle-grid" aria-pressed="true"/);
  assert.match(ready, /<main class="workspace" id="workspace" role="tabpanel" aria-labelledby="document-tab-tab-1"/);
  const toolbar = ready.slice(ready.indexOf('<div class="toolbar"'), ready.indexOf('</div>\n    <main class="workspace"'));
  assert.doesNotMatch(toolbar, /show-plugins|show-workflows|PDF content editing needs a plugin engine/);
  assert.equal((toolbar.match(/class="toolbar-label"/g) ?? []).length, 2);
  assert.equal((toolbar.match(/toolbar-label toolbar-label-compact/g) ?? []).length, 12);
  assert.match(ready, /class="rail-button [^"]*"[^>]+data-action="show-workflows"/);
});

test('editor compact toolbar and empty frame CSS prevent fixed-width clipping', () => {
  const css = readCssSources();
  assert.match(css, /\.document-stage\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*auto/s);
  assert.match(css, /@media \(max-width: 1080px\)[\s\S]*\.toolbar-label,[\s\S]*clip:\s*rect\(0, 0, 0, 0\)/s);
  assert.match(css, /\.toolbar\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.paper-frame-empty\s*\{[^}]*min-height:\s*0[^}]*border:\s*0/s);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.empty-paper\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.document-controls\s*\{[^}]*overflow-x:\s*auto/s);
});

test('editor view exposes advanced navigation, controlled raster, reflow, split, grid, and presentation surfaces', () => {
  const base = {
    document: { isOpen: true, name: 'viewer.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:viewer', modified: false },
    analysis: {
      status: 'ready', documentId: SOURCE_ID, sha256: SOURCE_SHA256, progress: null, inspection: { pageCount: 2 },
      textPages: [{ page: 1, text: 'Page one text' }, { page: 2, text: 'Page two text' }],
      thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 },
    },
    selectedPage: 1,
    navigationHistory: [1, 2],
    navigationIndex: 0,
    searchCaseSensitive: true,
    searchWholeWord: true,
  };
  const native = editorView(state(base));
  for (const action of ['toggle-controlled-render', 'toggle-reflow', 'toggle-split-view', 'cycle-page-layout', 'toggle-grid', 'history-back', 'history-forward', 'read-selected-page', 'presentation-mode']) {
    assert.match(native, new RegExp(`data-action="${action}"`));
  }
  for (const action of ['toggle-controlled-render', 'toggle-reflow', 'toggle-split-view']) {
    assert.match(native, new RegExp(`data-action="${action}" aria-pressed="false"`));
  }
  assert.match(native, /data-action="history-back"\s+disabled aria-label="Go to previous viewed page"/);
  assert.match(native, /data-action="history-forward"\s+aria-label="Go to next viewed page"/);
  const end = editorView(state({ ...base, navigationIndex: 1 }));
  assert.match(end, /data-action="history-back"\s+aria-label="Go to previous viewed page"/);
  assert.match(end, /data-action="history-forward"\s+disabled aria-label="Go to next viewed page"/);
  assert.match(native, /id="search-case-sensitive" type="checkbox" checked/);
  assert.match(native, /id="search-whole-word" type="checkbox" checked/);

  const reflow = editorView(state({ ...base, viewerMode: 'reflow' }));
  assert.match(reflow, /class="reflow-view"/);
  assert.match(reflow, /Page one text/);
  assert.match(reflow, /data-action="toggle-reflow" aria-pressed="true"/);
  const split = editorView(state({ ...base, viewerMode: 'split' }));
  assert.equal((split.match(/split-native-pdf/g) ?? []).length, 1);
  assert.match(split, /class="split-reflow-view"/);
  assert.match(split, /class="[^"]*\bsplit-proof-bar\b[^"]*"/);
  assert.match(split, /class="inspection-evidence"/);
  assert.match(split, /Native PDF and extracted text split preview/);
  assert.match(split, /data-action="toggle-split-view" aria-pressed="true"/);
  const prematureSplit = editorView(state({
    ...base,
    viewerMode: 'split',
    analysis: { ...base.analysis, status: 'loading', inspection: { pageCount: 0 } },
  }));
  assert.doesNotMatch(prematureSplit, /split-preview|#page=0/);
  assert.match(prematureSplit, /data="blob:viewer#page=1&amp;toolbar=1&amp;navpanes=0"/);
  const controlled = editorView(state({
    ...base, viewerMode: 'controlled',
    controlledRaster: { status: 'ready', page: 1, dpi: 192, url: 'blob:passive-page', error: null },
  }));
  assert.match(controlled, /Passive Poppler raster rendering of page 1/);
  assert.match(controlled, /bounded 2,304 px longest edge · PDF actions disabled · no selectable text/);
  assert.match(controlled, /data-action="toggle-controlled-render" aria-pressed="true"/);
  assert.match(controlled, /blob:passive-page/);
  assert.doesNotMatch(controlled, /<object class="native-pdf"/);
  const controlledLoading = editorView(state({
    ...base, viewerMode: 'controlled',
    controlledRaster: { status: 'loading', page: 1, dpi: 192, url: null, error: null },
  }));
  assert.match(controlledLoading, /role="status"/);
  assert.match(controlledLoading, /Rendering page 1 as a passive local image/);
  const controlledError = editorView(state({
    ...base, viewerMode: 'controlled',
    controlledRaster: { status: 'error', page: 1, dpi: 192, url: null, error: '<render failed>' },
  }));
  assert.match(controlledError, /data-action="retry-controlled-render"/);
  assert.match(controlledError, /data-action="toggle-controlled-render"/);
  assert.match(controlledError, /&lt;render failed&gt;/);
  assert.doesNotMatch(controlledError, /<render failed>/);
  const presentation = editorView(state({ ...base, showGrid: true, presentationMode: true }));
  assert.match(presentation, /app-shell is-presentation/);
  assert.match(presentation, /document-stage[^>]+show-grid/);
});

test('editor view exposes validated raster editing, structured export, and local comparison surfaces', () => {
  const html = editorView(state({
    document: { isOpen: true, name: 'primary.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:primary', modified: false },
    host: { status: 'ready', conversionReady: true, engines: [{ name: 'magick', available: true }] },
    analysis: {
      status: 'ready', documentId: 'doc', progress: null, inspection: { pageCount: 2 },
      textPages: [{ page: 1, text: 'Local text' }], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 },
    },
    selectedPage: 1,
    comparisonMode: 'pixel',
    comparisonFileName: '<secondary>.pdf',
    comparisonReport: {
      kind: 'pixel', stats: { changedPixels: 3, comparedPixels: 100 },
      pages: [{ page: 1, differenceImage: { encoding: 'base64', data: 'iVBORw0KGgo=' } }],
    },
  }));
  for (const operation of ['rotate', 'crop', 'resize', 'overlay', 'redact', 'flatten']) {
    assert.match(html, new RegExp(`data-raster-operation="${operation}"`));
  }
  for (const action of ['create-from-clipboard', 'create-clipboard-to-pdf', 'choose-combine-files', 'print-document', 'insert-blank-page', 'export-structured-text', 'choose-comparison-file', 'export-comparison-json', 'export-comparison-csv']) {
    assert.match(html, new RegExp(`data-action="${action}"`));
  }
  assert.match(html, /id="combine-picker"[^>]+multiple/);
  assert.match(html, /id="conversion-picker"[^>]+accept="\.png,\.jpg,\.jpeg,\.tif,\.tiff,\.doc,/);
  assert.match(html, /id="combine-picker"[^>]+accept="application\/pdf,\.pdf,\.png,\.jpg,\.jpeg,\.tif,\.tiff,\.doc,/);
  assert.doesNotMatch(html, /id="(?:conversion|combine)-picker"[^>]+accept="[^"]*\.(?:gif|bmp|webp)/u);
  assert.match(html, /Raster edits deliberately discard vectors/);
  assert.match(html, /3 changed of 100 compared pixels/);
  assert.match(html, /data:image\/png;base64,iVBORw0KGgo=/);
  assert.match(html, /&lt;secondary&gt;\.pdf/);
  assert.doesNotMatch(html, /<secondary>/);
});

test('editor exposes bounded local prepress review and labels previews as non-certifying', () => {
  const html = editorView(state({
    document: { isOpen: true, name: 'press.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:press', modified: false },
    host: {
      status: 'ready', prepressReady: true, outputIntentProfileReady: true,
      engines: [{ name: 'gs', available: true }, { name: 'magick', available: true }],
    },
    analysis: {
      status: 'ready', documentId: 'doc', progress: null, inspection: { pageCount: 1 },
      textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 },
    },
    selectedPage: 1,
    prepressDpi: '144',
    prepressResult: {
      kind: 'separation-preview', page: 1, requestedDpi: 144, effectiveDpi: 120,
      images: [{ label: '<Cyan>', format: 'image/png', data: 'iVBORw0KGgo=' }],
    },
  }));
  for (const action of ['prepress-ink-coverage', 'prepress-separations', 'prepress-overprint']) {
    assert.match(html, new RegExp(`data-action="${action}"`));
  }
  for (const action of ['prepress-convert-cmyk', 'prepress-impose-2up', 'prepress-impose-4up', 'prepress-production-validation']) {
    assert.match(html, new RegExp(`data-action="${action}"`));
  }
  assert.match(html, /data-action="prepress-assign-output-intent" >Create OutputIntent PDF/);
  assert.match(html, /id="imposition-marks" type="checkbox" disabled/);
  assert.match(html, /Production marks unavailable/);
  assert.match(html, /data-action="prepress-run-profile"/);
  assert.match(html, /id="preflight-profile"/);
  assert.match(html, /Local prepress review/);
  assert.match(html, /bounded from 144/);
  assert.match(html, /&lt;Cyan&gt;/);
  assert.doesNotMatch(html, /<Cyan>/);
  assert.match(html, /Fixed-profile CMYK conversion does not assign an OutputIntent/);
  assert.match(html, /does not establish PDF\/X conformance/);

  const artifact = editorView(state({
    document: { isOpen: true, name: 'press.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:press', modified: false },
    host: { status: 'ready', engines: [] },
    analysis: { status: 'ready', documentId: 'doc', inspection: { pageCount: 1 }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 } },
    prepressResult: { kind: 'icc-cmyk-artifact', artifact: { displayName: '<cmyk>.pdf' } },
  }));
  assert.match(artifact, /CMYK ICC-derived PDF ready/);
  assert.match(artifact, /&lt;cmyk&gt;\.pdf/);
  assert.match(artifact, /not PDF\/X certification/);
  assert.match(artifact, /data-action="prepress-assign-output-intent" disabled/);

  const outputIntentArtifact = editorView(state({
    document: { isOpen: true, name: 'press.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:press', modified: false },
    host: { status: 'ready', engines: [] },
    analysis: { status: 'ready', documentId: 'doc', inspection: { pageCount: 1 }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 } },
    prepressResult: { kind: 'output-intent-artifact', artifact: { displayName: '<intent>.pdf' } },
  }));
  assert.match(outputIntentArtifact, /OutputIntent PDF ready/);
  assert.match(outputIntentArtifact, /&lt;intent&gt;\.pdf/);
  assert.match(outputIntentArtifact, /does not establish PDF\/X conformance/);

  const preflight = editorView(state({
    document: { isOpen: true, name: 'unsafe<press>.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:press', modified: false },
    host: { status: 'ready', engines: [] },
    analysis: { status: 'ready', documentId: 'doc', inspection: { pageCount: 1 }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 } },
    selectedPage: 1,
    preflightProfile: 'archive-review',
    prepressResult: {
      kind: 'preflight-review', status: 'fail', profile: { id: 'archive-review' },
      counts: { pass: 1, warning: 0, fail: 1, 'not-checked': 1 },
      checks: [{ id: '<unsafe>', status: 'fail', summary: '<script>unsafe</script>' }],
    },
  }));
  assert.match(preflight, /data-action="export-preflight-json"/);
  assert.match(preflight, /non-authoritative/);
  assert.match(preflight, /&lt;unsafe&gt;/);
  assert.match(preflight, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(preflight, /<script>unsafe<\/script>/);
});

test('editor keeps authoritative standards validation separate from heuristic preflight and escapes receipts', () => {
  const html = editorView(state({
    document: { isOpen: true, name: 'archive.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:archive', modified: false },
    host: { status: 'ready', standardsValidationReady: true, engines: [] },
    analysis: { status: 'ready', documentId: 'doc', inspection: { pageCount: 1 }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 } },
    standardsProfile: 'pdfa-2u',
    standardsValidationResult: {
      kind: 'standards-validation', status: 'noncompliant', authoritative: true, complete: true,
      standard: { family: 'PDF/A', profile: '<pdfa-2u>' },
      counts: { passedRules: 80, failedRules: 1, passedChecks: 400, failedChecks: 2 },
      engine: { name: 'veraPDF', version: '<1.30.1>' },
    },
  }));
  assert.match(html, /Authoritative standards validation/);
  assert.match(html, /id="standards-profile"/);
  assert.match(html, /PDF\/X — unavailable/);
  assert.match(html, /data-action="run-standards-validation"/);
  assert.doesNotMatch(html, /data-action="run-standards-validation" disabled/);
  assert.match(html, /data-action="export-standards-validation"/);
  assert.match(html, /1 failed rules/);
  assert.match(html, /&lt;pdfa-2u&gt;/);
  assert.match(html, /&lt;1\.30\.1&gt;/);
  assert.doesNotMatch(html, /<pdfa-2u>|<1\.30\.1>/);
  assert.match(html, /not legal, accessibility-usability, print-production, or PDF\/X certification/);

  const unavailable = editorView(state({
    document: { isOpen: true, name: 'archive.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:archive', modified: false },
    host: { status: 'ready', standardsValidationReady: false, engines: [] },
    analysis: { status: 'ready', documentId: 'doc', inspection: { pageCount: 1 }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 } },
  }));
  assert.match(unavailable, /data-action="run-standards-validation" disabled/);
  assert.match(unavailable, /No trusted validator bundle is currently staged/);
});

test('editor exposes a document-bound non-authoritative accessibility review', () => {
  const html = editorView(state({
    document: { isOpen: true, name: 'accessible.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:a11y', modified: false },
    host: { status: 'ready', accessibilityRemediationReady: true, engines: [] },
    analysis: { status: 'ready', documentId: 'doc', sha256: 'a'.repeat(64), inspection: { pageCount: 2 }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 } },
    accessibilityReviewResult: {
      kind: 'accessibility-review', status: 'review-required', sourceDigest: 'a'.repeat(64), profile: { id: 'basic-local-review' },
      counts: { pass: 2, warning: 1, fail: 0, 'not-checked': 4 },
      checks: [{ id: '<tag-check>', status: 'warning', summary: '<script>review</script>' }],
      remediationPlan: {
        candidateCount: 1,
        truncated: false,
        candidates: [{ action: '<repair-heading>', reason: '<script>candidate</script>', status: 'proposed-not-applied' }],
      },
    },
  }));
  for (const action of ['run-accessibility-review', 'export-accessibility-review', 'create-accessibility-proposal']) assert.match(html, new RegExp(`data-action="${action}"`));
  assert.doesNotMatch(html, /data-action="create-accessibility-proposal" disabled/);
  assert.match(html, /not PDF\/UA conformance validation/);
  assert.match(html, /1 source-bound remediation candidate/);
  assert.match(html, /proposed-not-applied/);
  assert.match(html, /&lt;repair-heading&gt;/);
  assert.match(html, /&lt;script&gt;candidate&lt;\/script&gt;/);
  assert.match(html, /&lt;tag-check&gt;/);
  assert.match(html, /&lt;script&gt;review&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>(?:review|candidate)<\/script>/);
});
