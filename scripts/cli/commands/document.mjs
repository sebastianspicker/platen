import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { structuredTextExport } from '../../../src/core/document-analysis.js';
import { validateAccessibilityReviewReport } from '../../host/accessibility-review-report-validation.mjs';
import { validateOperationProvenance } from '../../host/operation-provenance.mjs';
import { serializeSignatureReview, validateSignatureReviewReport } from '../../host/signature-review-report.mjs';

const BLANK_WIDTH_POINTS = 612;
const BLANK_HEIGHT_POINTS = 792;
const MAX_BLANK_PDF_BYTES = 1024 * 1024;

function invalidCreatedPdf(runtime, message) {
  runtime.fail('CLI_INVALID_CREATED_PDF', message);
}

function assertBlankProvenance(document, pages, runtime) {
  let operation;
  try {
    operation = validateOperationProvenance(document?.operation);
  } catch {
    invalidCreatedPdf(runtime, 'Blank-PDF creation returned invalid provenance.');
  }
  const valid = document?.origin === 'derived'
    && document.mediaType === 'application/pdf'
    && document.displayName === 'untitled.pdf'
    && Number.isSafeInteger(document.size)
    && document.size >= 64
    && document.size <= MAX_BLANK_PDF_BYTES
    && /^[a-f0-9]{64}$/u.test(document.sha256 ?? '')
    && operation.type === 'create-blank-pdf'
    && operation.inputs.length === 0
    && operation.parameters.pages === pages
    && operation.parameters.widthPoints === BLANK_WIDTH_POINTS
    && operation.parameters.heightPoints === BLANK_HEIGHT_POINTS
    && operation.parameters.title === 'Untitled'
    && operation.expected.pageCount === pages
    && operation.validation.passed === true
    && operation.validation.pageCount === pages
    && operation.validation.validators.includes('local-pdf-factory');
  if (!valid) {
    invalidCreatedPdf(runtime, 'Blank-PDF creation returned mismatched provenance.');
  }
}

function assertBlankInspection({ inspection, pageOne, textPages }, pages, runtime) {
  const checkedIndicators = String(inspection?.encrypted).toLowerCase() === 'no'
    && String(inspection?.javascript).toLowerCase() === 'no'
    && String(inspection?.form).toLowerCase() === 'none';
  const textIsEmpty = Array.isArray(textPages)
    && textPages.length === pages
    && textPages.every((entry, index) => entry?.page === index + 1
      && typeof entry.text === 'string' && entry.text.trim().length === 0);
  const valid = inspection?.pageCount === pages
    && inspection?.title === 'Untitled'
    && checkedIndicators
    && pageOne?.page === 1
    && pageOne.widthPoints === BLANK_WIDTH_POINTS
    && pageOne.heightPoints === BLANK_HEIGHT_POINTS
    && textIsEmpty;
  if (!valid) {
    invalidCreatedPdf(runtime, 'Blank-PDF inspection did not match the fixed document contract.');
  }
}

async function runCreateBlank(application, command, stdout, signal, runtime) {
  const { cancelled, canonicalOutputTarget, emit, writeExclusive } = runtime;
  await canonicalOutputTarget(command.output);
  cancelled(signal);
  const document = await application.conversion.createBlank({
    pages: command.pages,
    widthPoints: BLANK_WIDTH_POINTS,
    heightPoints: BLANK_HEIGHT_POINTS,
    title: 'Untitled',
  });
  cancelled(signal);
  assertBlankProvenance(document, command.pages, runtime);
  const { bytes, inspection, pageOne, textPages } = await application.conversion
    .prepareBlankExport(document.id, { pages: command.pages, signal });
  cancelled(signal);
  assertBlankInspection({ inspection, pageOne, textPages }, command.pages, runtime);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== document.size || digest !== document.sha256) {
    invalidCreatedPdf(runtime, 'Blank-PDF bytes do not match the private document record.');
  }
  cancelled(signal);
  await writeExclusive(command.output, bytes, signal);
  await emit(stdout, {
    kind: 'blank-pdf',
    output: basename(command.output),
    title: 'Untitled',
    pages: command.pages,
    pageSize: { widthPoints: BLANK_WIDTH_POINTS, heightPoints: BLANK_HEIGHT_POINTS },
    size: bytes.length,
    sha256: digest,
    validation: {
      passed: true,
      popplerIndicators: {
        encrypted: 'no',
        javascript: 'no',
        form: 'none',
      },
      textEmpty: true,
      sourceIntegrity: 'descriptor-bound-sha256',
    },
    localOnly: true,
  });
}

export async function runDocumentCommand(application, command, stdout, signal, runtime) {
  const { uploadPdf, outputValue, cancelled } = runtime;
  if (command.command === 'create-blank') {
    await runCreateBlank(application, command, stdout, signal, runtime);
    return;
  }
  if (command.command === 'signature-review') {
    await runtime.canonicalOutputTarget(command.output);
    cancelled(signal);
  }
  const document = await uploadPdf(application, command.input, signal);
  if (command.command === 'accessibility-review') {
    const report = validateAccessibilityReviewReport(
      await application.accessibilityReviews.review(document.id, { signal }),
      { expectedSourceDigest: document.sha256, requireTrustedIssue: true },
    );
    cancelled(signal);
    await outputValue(command, stdout, report, signal);
    return;
  }
  if (command.command === 'signature-review') {
    const report = serializeSignatureReview(
      await application.service.verifySignatures(document.id, { signal }),
    );
    const validated = validateSignatureReviewReport(report, {
      expectedSourceDigest: document.sha256,
      requireTrustedIssue: true,
    });
    cancelled(signal);
    await outputValue(command, stdout, validated, signal);
    return;
  }
  if (command.command === 'inspect') {
    const inspection = await application.service.inspect(document.id, { signal });
    cancelled(signal);
    const structure = command.structure ? await application.service.inspectStructure(document.id, { includeTagText: command.includeTagText, signal }) : null;
    cancelled(signal);
    await outputValue(command, stdout, { source: { displayName: document.displayName, size: document.size, sha256: document.sha256 }, inspection, structure }, signal);
    return;
  }
  const inspection = await application.service.inspect(document.id, { signal });
  cancelled(signal);
  const pages = await application.service.extractText(document.id, inspection.pageCount, { signal });
  cancelled(signal);
  const value = command.format === 'text'
    ? `${pages.map(({ page, text }) => `--- Page ${page} ---\n${text}`).join('\n\n')}\n`
    : ['rtf', 'html', 'xml'].includes(command.format)
      ? structuredTextExport(pages, command.format, { title: document.displayName }).data
      : { sourceDigest: document.sha256, pages };
  cancelled(signal);
  await outputValue(command, stdout, value, signal);
}
