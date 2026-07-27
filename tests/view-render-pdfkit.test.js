import test from 'node:test';
import {
  assert,
  editorView,
} from './support/view-render-fixture.js';
import {
  checkboxState,
  emptyOutlineState,
  fullPdfKitState,
  localLinkState,
  radioState,
  unavailablePdfKitState,
} from './support/view-render-pdfkit-states.js';

const render = (fixture) => editorView(fixture());

test('PDFKit editor exposes each source-bound local action', () => {
  const html = render(fullPdfKitState);
  const actions = [
    'run-pdfkit-inspection', 'export-pdfkit-inspection', 'split-verified-outline',
    'create-incremental-bleed-box-copy', 'create-pdfkit-metadata-copy',
    'create-pdfkit-pagebox-copy', 'create-pdfkit-rotation-copy',
    'create-pdfkit-annotation-copy', 'create-pdfkit-line-annotation-copy',
    'create-pdfkit-ink-annotation-copy', 'create-pdfkit-local-goto-copy',
    'remove-pdfkit-local-goto-link', 'create-pdfkit-outline-copy',
    'remove-pdfkit-outline-bookmark', 'rename-pdfkit-outline-bookmark',
    'fill-pdfkit-form-field', 'update-pdfkit-annotation', 'remove-pdfkit-annotation',
  ];
  for (const action of actions) assert.match(html, new RegExp(`data-action="${action}"`));
  assert.match(html, /data-action="split-verified-outline" >Split at verified top-level bookmarks \(macOS\)<\/button>/);
  assert.match(html, /re-inspects the immutable source/);
  assert.match(html, /data-action="fill-pdfkit-form-field" >/);
  assert.match(html, /data-action="update-pdfkit-annotation" disabled/);
});

test('PDFKit editor escapes and bounds its structural inventory', () => {
  const html = render(fullPdfKitState);
  for (const escaped of [
    '&lt;script&gt;title&lt;/script&gt;', '&lt;chapter&gt;', '&lt;Front-i&gt;',
    '&lt;destination&gt;', '&lt;https://example.test&gt;', '&lt;Review layer&gt;',
  ]) assert.match(html, new RegExp(escaped.replaceAll('/', '\\/')));
  assert.match(html, /Pinned Apple PDFKit inventory/);
  assert.match(html, /4 bounded annotation records/);
  assert.match(html, /3 bounded widget records/);
  assert.match(html, /Bookmarks and outlines/);
  assert.match(html, /&lt;unresolved outline&gt; · unresolved destination/);
  assert.doesNotMatch(html, /<button[^>]*>[^<]*&lt;unresolved outline&gt;/);
  assert.match(html, /Bookmark inventory is truncated/);
  assert.match(html, /data-page-number="1">&lt;Front-i&gt; · physical page 1/);
  assert.match(html, /data-page-number="2">&lt;Body-3&gt; · physical page 2/);
  assert.match(html, /local links navigate the open PDF/);
  assert.match(html, /External and remote targets are inert text/);
  assert.match(html, /Layers cannot be toggled or edited/);
  assert.doesNotMatch(html, /<script>title<\/script>/);
  assert.doesNotMatch(html, /<Front-i>|<Body-3>|<destination>|<unresolved outline>|<https:\/\/example\.test>|<Review layer>/);
});

test('PDFKit editor describes derived-edit limits without leaking private values', () => {
  const html = render(fullPdfKitState);
  for (const escaped of [
    '&lt;private-ink&gt;', '&lt;40,50;90,120;180,210&gt;', '&lt;approval&gt;',
    '&lt;delivery&gt;', '&lt;metadata&gt;', '&lt;review&gt;', '&lt;private-line&gt;',
    '&lt;private-value&gt;', '&lt;replacement&gt;', '&lt;derived&gt;\\.pdf',
    'Existing &lt;signature&gt; may be invalid',
  ]) assert.match(html, new RegExp(escaped.replaceAll('/', '\\/')));
  assert.doesNotMatch(html, /<private-ink>|<metadata>|<review>|<private-line>|<private-value>|<replacement>|<derived>|<signature>/);
  assert.match(html, /PDFKit’s redundant <code>\/A \/GoTo<\/code>/);
  assert.match(html, /AcroForm button controls/);
  assert.match(html, /&lt;approval&gt; · checkbox · page 1 annotation 3 · eligible for private validation below/);
  assert.match(html, /&lt;delivery&gt; · radio · page 1 annotation 4 · eligible for private validation below/);
  assert.match(html, /expose no current value, export\/on-state name, or appearance data/);
  assert.match(html, /author one strictly local GoTo link/);
  assert.match(html, /Structure-preserving edits \+ PDFKit-derived fallbacks/);
  assert.match(html, /PDFKit-derived PDF created/);
  assert.match(html, /<option value="text" selected>Sticky note<\/option>/);
  assert.match(html, /Sticky notes may open a viewer-provided popup, but this profile embeds no PDF action/);
  assert.match(html, /Fill a source-bound AcroForm field/);
  assert.match(html, /leaving it empty clears only a non-required, single-selection field/);
  assert.match(html, /Update or remove a source-bound annotation/);
  assert.match(html, /Create verified removal copy/);
  assert.match(html, /narrow selective-sanitization subset/);
  assert.match(html, /Raw annotation identity must be unique across the whole document/);
  assert.match(html, /orphan-byte scrubbing/);
});

test('PDFKit editor handles empty and unavailable inspection states honestly', () => {
  const emptyOutlineHtml = render(emptyOutlineState);
  assert.match(emptyOutlineHtml, /Bookmarks and outlines/);
  assert.match(emptyOutlineHtml, /No bookmark or outline entries were found/);
  assert.match(emptyOutlineHtml, /data-action="split-verified-outline" disabled/);

  const unavailable = render(unavailablePdfKitState);
  assert.match(unavailable, /data-action="run-pdfkit-inspection" disabled/);
  assert.match(unavailable, /data-action="create-pdfkit-metadata-copy" disabled/);
  assert.match(unavailable, /npm run native:build:pdfkit/);
});

test('PDFKit editor selects private controls by exact widget family', () => {
  const checkboxHtml = render(checkboxState);
  assert.match(checkboxHtml, /Text, choice, checkbox, or radio widget on selected page/);
  assert.match(checkboxHtml, /&lt;consent&gt; · checkbox · page annotation 3/);
  assert.match(checkboxHtml, /id="pdfkit-button-state"/);
  assert.match(checkboxHtml, /<option value="off" selected>Off<\/option>/);
  assert.match(checkboxHtml, /privately resolves and verifies its custom appearance state/);
  assert.doesNotMatch(checkboxHtml, /id="pdfkit-form-value"/);

  const radioHtml = render(radioState);
  assert.match(radioHtml, /&lt;delivery&gt; · radio · page annotation 4/);
  assert.match(radioHtml, /selects this exact radio widget/);
  assert.match(radioHtml, /Select radio option in derived PDF/);
  assert.match(radioHtml, /canonical 2–50 option parent-and-kids group/);
  assert.doesNotMatch(radioHtml, /id="pdfkit-button-state"|id="pdfkit-form-value"/);
});

test('PDFKit editor exposes verified local navigation and drawing operations', () => {
  const html = render(localLinkState);
  for (const pattern of [
    /<option value="2" selected>Page 2<\/option>/,
    /data-action="create-pdfkit-local-goto-copy" >/,
    /data-action="remove-pdfkit-local-goto-link" >/,
    /data-action="create-pdfkit-outline-copy" >/,
    /data-action="remove-pdfkit-outline-bookmark" >/,
    /data-action="rename-pdfkit-outline-bookmark" >/,
    /data-action="create-pdfkit-line-annotation-copy" >/,
    /data-action="create-pdfkit-ink-annotation-copy" >/,
    /data-action="create-pdfkit-rotation-copy" >/,
  ]) assert.match(html, pattern);
  assert.match(html, /raw destination and the reopened link/);
  assert.match(html, /strict dual direct-<code>\/Dest<\/code> plus <code>\/A \/GoTo \/D<\/code> shape/);
  assert.match(html, /Top-level local bookmark/);
  assert.match(html, /&lt;private-bookmark&gt;/);
  assert.match(html, /GoTo-action outlines fail closed/);
  assert.match(html, /&lt;renamed appendix&gt;/);
  assert.match(html, /changes only its decoded NFC title/);
  assert.match(html, /&lt;removable appendix&gt;/);
  assert.match(html, /extracted-text hash, fixed render hash/);
  assert.doesNotMatch(html, new RegExp('e'.repeat(64), 'u'));
  assert.match(html, /fixes both line endings to None/);
  assert.match(html, /raw <code>\/InkList<\/code>/);
  assert.match(html, /Page 1 currently reports 0°/);
  assert.match(html, /<option value="90" selected>90°<\/option>/);
  assert.match(html, /Poppler independently confirms the output rotation/);
});
