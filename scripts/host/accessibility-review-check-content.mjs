import { check } from './accessibility-review-check-contract.mjs';
import { languageFromStructure } from './accessibility-review-check-tag-structure.mjs';

function fontEvidence(fonts) {
  const unicodeFonts = fonts.filter((font) => String(font?.unicode ?? '').toLowerCase() === 'yes').length;
  const nonUnicodeFonts = fonts.filter((font) => String(font?.unicode ?? '').toLowerCase() === 'no').length;
  const embeddedFonts = fonts.filter((font) => String(font?.embedded ?? '').toLowerCase() === 'yes').length;
  const nonEmbeddedFonts = fonts.filter((font) => String(font?.embedded ?? '').toLowerCase() === 'no').length;
  return {
    unicodeFonts,
    nonUnicodeFonts,
    unknownUnicodeFonts: fonts.length - unicodeFonts - nonUnicodeFonts,
    embeddedFonts,
    nonEmbeddedFonts,
    unknownEmbeddedFonts: fonts.length - embeddedFonts - nonEmbeddedFonts,
  };
}

function fontChecks(fonts, evidence) {
  const unicodeCheck = evidence.nonUnicodeFonts
    ? check('font-tounicode', 'fail', 'One or more fonts lack Poppler Unicode mapping evidence.')
    : evidence.unknownUnicodeFonts
      ? check('font-tounicode', 'warning', 'One or more fonts have unknown Unicode mapping evidence.')
      : fonts.length
        ? check('font-tounicode', 'pass', 'All listed fonts have Poppler Unicode mapping evidence.')
        : check('font-tounicode', 'not-checked', 'No fonts were listed for Unicode mapping review.');
  const embeddingCheck = evidence.nonEmbeddedFonts
    ? check('font-embedding', 'fail', 'One or more fonts are not reported as embedded.')
    : evidence.unknownEmbeddedFonts
      ? check('font-embedding', 'warning', 'One or more fonts have unknown embedding evidence.')
      : fonts.length
        ? check('font-embedding', 'pass', 'All listed fonts are reported as embedded.')
        : check('font-embedding', 'not-checked', 'No fonts were listed for embedding review.');
  return [unicodeCheck, embeddingCheck];
}

function formCheck(inspection, pdfkit) {
  const formKind = String(inspection.form ?? 'unknown').trim().toLowerCase();
  if (formKind === 'none') return check('form-semantics', 'pass', 'No PDF form was reported.');
  if (pdfkit.available) {
    return check(
      'form-semantics',
      'not-checked',
      `${pdfkit.widgetCount} bounded widget record${pdfkit.widgetCount === 1 ? '' : 's'} were inventoried, but labels, roles, and keyboard order are not proven.`,
    );
  }
  return check('form-semantics', 'not-checked', 'Form semantics require the optional PDFKit inventory and human review.');
}

export function contentChecks({ inspection, structure, fonts, images, pages, roles, pdfkit }) {
  const evidence = fontEvidence(fonts);
  const emptyTextPages = pages.filter((page) => !String(page?.text ?? '').trim()).length;
  const language = languageFromStructure(structure);
  const urlCount = Array.isArray(structure.urls) ? structure.urls.length : 0;
  const checks = [
    check('document-title', inspection.title?.trim() ? 'pass' : 'warning', inspection.title?.trim() ? 'PDF title metadata was detected.' : 'No PDF title metadata was detected.'),
    check('document-language', language ? 'pass' : 'warning', language ? 'Language metadata was detected.' : 'No detectable language metadata was found.'),
    ...fontChecks(fonts, evidence),
    check('empty-extracted-text-pages', emptyTextPages ? 'warning' : 'pass', emptyTextPages ? 'One or more pages produced no extracted text.' : 'Every page produced extracted text.'),
    check('image-alt-text', 'not-checked', images.length ? `${images.length} image resource${images.length === 1 ? '' : 's'} require human-authored alternative-text review.` : 'No image resources were listed; alternative-text semantics remain outside this engine.'),
    check('artifact-classification', 'not-checked', `${roles.roleCounts.Artifact ?? 0} standard Artifact role${roles.roleCounts.Artifact === 1 ? '' : 's'} were inventoried; decorative or repeated-content classification is not proven.`),
    formCheck(inspection, pdfkit),
    check('reading-order', 'not-checked', 'Poppler structure output cannot prove reading order.'),
    check('link-bookmark-semantics', 'not-checked', `${urlCount} object URL${urlCount === 1 ? '' : 's'} and ${pdfkit.available ? pdfkit.outlineItemCount : 'an unknown number of'} outline entries were inventoried; absence, purpose, destinations, and navigation semantics are not proven.`),
    check('contrast', 'not-checked', 'Poppler inspection cannot prove contrast.'),
    check('screen-reader-permissions', pdfkit.contentAccessibility === true ? 'pass' : pdfkit.contentAccessibility === false ? 'fail' : 'not-checked', pdfkit.contentAccessibility === true ? 'The isolated PDFKit inventory reports that content accessibility is permitted.' : pdfkit.contentAccessibility === false ? 'The isolated PDFKit inventory reports that content accessibility is not permitted.' : 'Screen-reader permission evidence requires the optional isolated PDFKit helper.'),
    check('pdf-ua-conformance', 'not-checked', 'This review does not validate PDF/UA conformance.'),
  ];
  return { checks, evidence: { ...evidence, emptyTextPages, urls: urlCount } };
}
