import { executeOfflineSignatureInspection, parsePageBoxes } from './pdf-service-foundation.mjs';
import { normalizePdfKitMutation } from './pdfkit-mutation-contract.mjs';
import {
  pdfKitPopplerBoxRectangle,
  pdfKitRectangleWithin,
  pdfKitRectanglesMatch,
  parsePdfKitInspectedPageRotation,
} from './pdfkit-mutation-validation.mjs';
import { fail } from './pdfkit-mutation-operation-errors.mjs';

async function inspectPage(poppler, inputPath, page, workspace, job, limits) {
  return poppler.execute(
    'inspectPage',
    { input: inputPath, page },
    {
      cwd: workspace,
      signal: job.signal,
      timeoutMs: limits.timeoutMs,
      maxStdoutBytes: 256 * 1024,
      maxStderrBytes: 128 * 1024,
    },
  );
}

const VERIFIED_PAGE_BOXES = Object.freeze({
  crop: Object.freeze({ key: 'cropBox', label: 'CropBox' }),
  bleed: Object.freeze({ key: 'bleedBox', label: 'BleedBox' }),
});

async function validatePageBox(context, normalized) {
  const target = VERIFIED_PAGE_BOXES[normalized.mutation.pageBox?.box];
  if (!target) return null;
  const { page, box, rect: requestedPageBox } = normalized.mutation.pageBox;
  const inspected = await inspectPage(
    context.poppler,
    context.inputPath,
    page,
    context.workspace,
    context.job,
    context.limits,
  );
  const [pageBoxes] = parsePageBoxes(inspected.stdout, { firstPage: page, lastPage: page });
  const mediaBox = pdfKitPopplerBoxRectangle(
    pageBoxes.boxes.mediaBox,
    `the MediaBox for page ${page}`,
  );
  const sourcePageBox = pdfKitPopplerBoxRectangle(
    pageBoxes.boxes[target.key],
    `the ${target.label} for page ${page}`,
  );
  if (!pdfKitRectangleWithin(requestedPageBox, mediaBox)) {
    fail(
      'INVALID_PDFKIT_MUTATION',
      `The requested ${target.label} must be fully contained in the selected page MediaBox.`,
    );
  }
  if (box === 'bleed') {
    const trimBox = pdfKitPopplerBoxRectangle(
      pageBoxes.boxes.trimBox,
      `the TrimBox for page ${page}`,
    );
    if (!pdfKitRectangleWithin(trimBox, requestedPageBox)) {
      fail(
        'INVALID_PDFKIT_MUTATION',
        'The requested BleedBox must fully contain the selected page TrimBox.',
      );
    }
  }
  if (pdfKitRectanglesMatch(sourcePageBox, requestedPageBox)) {
    fail(
      'INVALID_PDFKIT_MUTATION',
      `The requested ${target.label} would not change the source document.`,
    );
  }
  return Object.freeze({ page, box, label: target.label, key: target.key, requestedPageBox, sourcePageBox, mediaBox });
}

async function validateRotation(context, normalized) {
  if (!normalized.mutation.rotation) return;
  const { page, degrees } = normalized.mutation.rotation;
  const inspected = await inspectPage(
    context.poppler,
    context.inputPath,
    page,
    context.workspace,
    context.job,
    context.limits,
  );
  if (parsePdfKitInspectedPageRotation(inspected.stdout, page) === degrees) {
    fail(
      'INVALID_PDFKIT_MUTATION',
      'The requested page rotation would not change the source document.',
    );
  }
}

function unsupportedSourceMessage(normalized) {
  if (normalized.targeted && normalized.mutation.formFill) {
    return 'PDFKit form filling requires an unencrypted AcroForm without JavaScript.';
  }
  if (normalized.localGoTo) {
    return 'PDFKit local-link authoring requires an unencrypted PDF without forms or JavaScript.';
  }
  if (normalized.localGoToRemoval) {
    return 'PDFKit local-link removal requires an unsigned, unencrypted PDF without forms or JavaScript.';
  }
  if (normalized.outlineBookmark) {
    return 'PDFKit bookmark authoring requires an unsigned, unencrypted PDF without forms or JavaScript.';
  }
  if (normalized.outlineBookmarkRemoval) {
    return 'PDFKit bookmark removal requires an unsigned, unencrypted PDF without forms or JavaScript.';
  }
  if (normalized.outlineBookmarkRename) {
    return 'PDFKit bookmark rename requires an unsigned, unencrypted PDF without forms or JavaScript.';
  }
  if (normalized.lineAnnotation) {
    return 'PDFKit line annotation authoring requires an unencrypted PDF without forms or JavaScript.';
  }
  if (normalized.inkAnnotation) {
    return 'PDFKit ink annotation authoring requires an unencrypted PDF without forms or JavaScript.';
  }
  if (normalized.requiresUnsigned) {
    return 'PDFKit persistent page-box and page-rotation edits require an unencrypted PDF without forms or JavaScript.';
  }
  return 'PDFKit category and annotation rewrites require an unencrypted PDF without forms or JavaScript.';
}

function validateSourceClass(sourceInspection, normalized) {
  const sourceForm = String(sourceInspection.form).toLowerCase();
  const invalid = String(sourceInspection.encrypted).toLowerCase() !== 'no'
    || sourceForm !== normalized.expectedForm
    || String(sourceInspection.javascript).toLowerCase() !== 'no';
  if (invalid) fail('PDFKIT_SOURCE_UNSUPPORTED', unsupportedSourceMessage(normalized), 422);
}

async function validateUnsignedSource(context, normalized) {
  const required = normalized.targeted || normalized.localGoTo || normalized.localGoToRemoval
    || normalized.outlineBookmark || normalized.outlineBookmarkRemoval || normalized.outlineBookmarkRename
    || normalized.lineAnnotation
    || normalized.inkAnnotation || normalized.requiresUnsigned;
  if (!required) return;
  let signatures;
  try {
    signatures = await executeOfflineSignatureInspection(context.poppler, {
      input: context.inputPath,
      nssDirectory: context.workspace,
      signal: context.job.signal,
      timeoutMs: context.limits.timeoutMs,
    });
  } catch (error) {
    if (context.job.signal.aborted || error?.code === 'ENGINE_TIMEOUT'
      || error?.code === 'ENGINE_CANCELLED') throw error;
    fail(
      'PDFKIT_SIGNED_SOURCE_UNSUPPORTED',
      'Source-bound PDFKit mutations reject signed or indeterminate-signature PDFs.',
      422,
    );
  }
  if (signatures.status !== 'unsigned' || signatures.signatureCount !== 0) {
    fail(
      'PDFKIT_SIGNED_SOURCE_UNSUPPORTED',
      'Source-bound PDFKit mutations reject signed or indeterminate-signature PDFs.',
      422,
    );
  }
}

export async function validatePdfKitMutationOperation(context) {
  const normalized = normalizePdfKitMutation({
    profile: context.profile,
    input: context.mutationInput,
    sourceInspection: context.sourceInspection,
  });
  const pageBoxEvidence = await validatePageBox(context, normalized);
  await validateRotation(context, normalized);
  validateSourceClass(context.sourceInspection, normalized);
  if (context.sourceInspection.pageCount > context.limits.maxPages) {
    fail(
      'PDFKIT_PAGE_LIMIT',
      `PDFKit mutation is limited to ${context.limits.maxPages} pages.`,
      422,
    );
  }
  await validateUnsignedSource(context, normalized);
  return Object.freeze({ normalized, pageBoxEvidence });
}
