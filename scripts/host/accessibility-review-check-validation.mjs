import { tagSemanticChecks } from './accessibility-review-check-tag-structure.mjs';

function requireCheck(check, status, summary, fail) {
  if (check.status !== status || check.summary !== summary) {
    fail(`Accessibility check ${check.id} does not match its evidence-derived result.`);
  }
}

function requireChoice(check, choices, fail) {
  const match = choices.some(({ status, summary }) => (
    check.status === status && check.summary === summary
  ));
  if (!match) fail(`Accessibility check ${check.id} is not a fixed profile result.`);
}

function requireFontChecks(byId, evidence, fail) {
  const unicode = evidence.nonUnicodeFonts
    ? { status: 'fail', summary: 'One or more fonts lack Poppler Unicode mapping evidence.' }
    : evidence.unknownUnicodeFonts
      ? { status: 'warning', summary: 'One or more fonts have unknown Unicode mapping evidence.' }
      : evidence.fonts
        ? { status: 'pass', summary: 'All listed fonts have Poppler Unicode mapping evidence.' }
        : { status: 'not-checked', summary: 'No fonts were listed for Unicode mapping review.' };
  const embedding = evidence.nonEmbeddedFonts
    ? { status: 'fail', summary: 'One or more fonts are not reported as embedded.' }
    : evidence.unknownEmbeddedFonts
      ? { status: 'warning', summary: 'One or more fonts have unknown embedding evidence.' }
      : evidence.fonts
        ? { status: 'pass', summary: 'All listed fonts are reported as embedded.' }
        : { status: 'not-checked', summary: 'No fonts were listed for embedding review.' };
  requireCheck(byId.get('font-tounicode'), unicode.status, unicode.summary, fail);
  requireCheck(byId.get('font-embedding'), embedding.status, embedding.summary, fail);
}

function requireFormCheck(check, pdfkit, fail) {
  const choices = [{ status: 'pass', summary: 'No PDF form was reported.' }];
  choices.push(pdfkit.available
    ? {
      status: 'not-checked',
      summary: `${pdfkit.widgetCount} bounded widget record${pdfkit.widgetCount === 1 ? '' : 's'} were inventoried, but labels, roles, and keyboard order are not proven.`,
    }
    : {
      status: 'not-checked',
      summary: 'Form semantics require the optional PDFKit inventory and human review.',
    });
  requireChoice(check, choices, fail);
}

function requireLinkCheck(check, evidence, fail) {
  const pdfkit = evidence.optionalPdfKit;
  const outline = pdfkit.available ? pdfkit.outlineItemCount : 'an unknown number of';
  requireCheck(
    check,
    'not-checked',
    `${evidence.urls} object URL${evidence.urls === 1 ? '' : 's'} and ${outline} outline entries were inventoried; absence, purpose, destinations, and navigation semantics are not proven.`,
    fail,
  );
}

export function validateAccessibilityCheckSemantics(report, fail) {
  const byId = new Map(report.checks.map((entry) => [entry.id, entry]));
  const tagged = byId.get('tagged-indicator');
  requireChoice(tagged, [
    { status: 'pass', summary: 'Poppler reported the document as tagged.' },
    { status: 'fail', summary: 'Poppler did not report the document as tagged.' },
  ], fail);
  const structure = byId.get('tag-structure-listing');
  requireChoice(structure, [
    { status: 'pass', summary: 'Poppler returned a tag-structure listing.' },
    { status: 'fail', summary: 'Poppler did not return a tag-structure listing.' },
  ], fail);
  const expectedTagChecks = tagSemanticChecks({
    taggedIndicator: tagged.status === 'pass',
    tagStructure: structure.status === 'pass',
    roles: report.evidence.tagRoles,
  });
  for (const expected of expectedTagChecks) {
    requireCheck(byId.get(expected.id), expected.status, expected.summary, fail);
  }
  requireChoice(byId.get('document-title'), [
    { status: 'pass', summary: 'PDF title metadata was detected.' },
    { status: 'warning', summary: 'No PDF title metadata was detected.' },
  ], fail);
  requireChoice(byId.get('document-language'), [
    { status: 'pass', summary: 'Language metadata was detected.' },
    { status: 'warning', summary: 'No detectable language metadata was found.' },
  ], fail);
  requireFontChecks(byId, report.evidence, fail);
  requireCheck(
    byId.get('empty-extracted-text-pages'),
    report.evidence.emptyExtractedTextPages ? 'warning' : 'pass',
    report.evidence.emptyExtractedTextPages
      ? 'One or more pages produced no extracted text.'
      : 'Every page produced extracted text.',
    fail,
  );
  requireCheck(
    byId.get('image-alt-text'),
    'not-checked',
    report.evidence.images
      ? `${report.evidence.images} image resource${report.evidence.images === 1 ? '' : 's'} require human-authored alternative-text review.`
      : 'No image resources were listed; alternative-text semantics remain outside this engine.',
    fail,
  );
  const artifacts = report.evidence.tagRoles.roleCounts.Artifact ?? 0;
  requireCheck(
    byId.get('artifact-classification'),
    'not-checked',
    `${artifacts} standard Artifact role${artifacts === 1 ? '' : 's'} were inventoried; decorative or repeated-content classification is not proven.`,
    fail,
  );
  requireFormCheck(byId.get('form-semantics'), report.evidence.optionalPdfKit, fail);
  requireCheck(byId.get('reading-order'), 'not-checked', 'Poppler structure output cannot prove reading order.', fail);
  requireLinkCheck(byId.get('link-bookmark-semantics'), report.evidence, fail);
  requireCheck(byId.get('contrast'), 'not-checked', 'Poppler inspection cannot prove contrast.', fail);
  const permission = report.evidence.optionalPdfKit.contentAccessibility;
  requireCheck(
    byId.get('screen-reader-permissions'),
    permission === true ? 'pass' : permission === false ? 'fail' : 'not-checked',
    permission === true
      ? 'The isolated PDFKit inventory reports that content accessibility is permitted.'
      : permission === false
        ? 'The isolated PDFKit inventory reports that content accessibility is not permitted.'
        : 'Screen-reader permission evidence requires the optional isolated PDFKit helper.',
    fail,
  );
  requireCheck(byId.get('pdf-ua-conformance'), 'not-checked', 'This review does not validate PDF/UA conformance.', fail);
}
