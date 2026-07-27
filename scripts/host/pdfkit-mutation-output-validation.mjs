import { join } from 'node:path';
import { digestFile } from './document-store.mjs';
import { HostError } from './host-error.mjs';
import { parsePageBoxes, parsePdfInfo } from './pdf-service-foundation.mjs';
import {
  assertPdfKitFileIdentity, assertPdfKitPng, assertPdfKitWorkspace, MAX_PDFKIT_SOURCE_BYTES,
  pdfKitPopplerBoxRectangle, pdfKitRectanglesMatch, parsePdfKitInspectedPageRotation,
  PDFKIT_WORKSPACE_AFTER_FILES,
} from './pdfkit-mutation-validation.mjs';
import { assertPrivateSourceCopy } from './private-source-copy.mjs';
import { readClosedClassicPdfOutput } from './pdf-classic-closed-output.mjs';

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

function runOptions(workspace, signal, timeoutMs, maxStdoutBytes) {
  return { cwd: workspace, signal, timeoutMs, maxStdoutBytes, maxStderrBytes: 128 * 1024 };
}

export async function validatePdfKitMutationOutput({
  poppler, store, documentId, workspace, signal, timeoutMs, source, sourceInspection, normalized,
  pageBoxEvidence, sourcePath, outputPath, outputIdentity, requestPath, requestIdentity, requestDigest, sourceCopyIdentity,
}) {
  const closedOutput = normalized.selectiveSanitization
    ? await readClosedClassicPdfOutput(outputPath, outputIdentity) : null;
  const beforeValidationDigest = closedOutput?.sha256 ?? await digestFile(outputPath);
  const outputInspection = parsePdfInfo((await poppler.execute('inspect', { input: outputPath }, runOptions(workspace, signal, timeoutMs, 512 * 1024))).stdout);
  if (outputInspection.pageCount !== sourceInspection.pageCount) fail('PDFKIT_PAGE_COUNT_MISMATCH', 'PDFKit mutation changed the document page count.', 502);
  if (String(outputInspection.encrypted).toLowerCase() !== 'no' || String(outputInspection.form).toLowerCase() !== normalized.expectedForm || String(outputInspection.javascript).toLowerCase() !== 'no') {
    fail('PDFKIT_POSTFLIGHT_INVALID', 'PDFKit mutation changed page count or active-content safety state.', 502);
  }
  if (normalized.mutation.rotation) {
    const { page, degrees } = normalized.mutation.rotation;
    const inspectedPage = await poppler.execute('inspectPage', { input: outputPath, page }, runOptions(workspace, signal, timeoutMs, 256 * 1024));
    if (parsePdfKitInspectedPageRotation(inspectedPage.stdout, page) !== degrees) fail('PDFKIT_POSTFLIGHT_INVALID', 'Poppler did not confirm the requested persistent page rotation.', 502);
  }
  if (pageBoxEvidence) {
    const inspectedPage = await poppler.execute('inspectPage', { input: outputPath, page: pageBoxEvidence.page }, runOptions(workspace, signal, timeoutMs, 256 * 1024));
    const [pageBoxes] = parsePageBoxes(inspectedPage.stdout, { firstPage: pageBoxEvidence.page, lastPage: pageBoxEvidence.page });
    const outputPageBox = pdfKitPopplerBoxRectangle(pageBoxes.boxes[pageBoxEvidence.key], `the output ${pageBoxEvidence.label} for page ${pageBoxEvidence.page}`);
    if (!pdfKitRectanglesMatch(outputPageBox, pageBoxEvidence.requestedPageBox)) fail('PDFKIT_POSTFLIGHT_INVALID', `Poppler did not confirm the requested persistent ${pageBoxEvidence.label}.`, 502);
  }
  const validationFiles = [];
  for (let page = 1; page <= outputInspection.pageCount; page += 1) {
    const outputPrefix = join(workspace, `validation-${page}`);
    await poppler.execute('renderPagePng', { input: outputPath, outputPrefix, page, maxDimension: 256 }, runOptions(workspace, signal, timeoutMs, 64 * 1024));
    const outputPng = `${outputPrefix}.png`;
    await assertPdfKitPng(outputPng); validationFiles.push(`validation-${page}.png`);
    if (pageBoxEvidence?.box === 'bleed') {
      const sourcePrefix = join(workspace, `source-validation-${page}`);
      await poppler.execute('renderPagePng', { input: sourcePath, outputPrefix: sourcePrefix, page, maxDimension: 256 }, runOptions(workspace, signal, timeoutMs, 64 * 1024));
      const sourcePng = `${sourcePrefix}.png`;
      await assertPdfKitPng(sourcePng); validationFiles.push(`source-validation-${page}.png`);
      if (await digestFile(sourcePng) !== await digestFile(outputPng)) {
        fail('PDFKIT_POSTFLIGHT_INVALID', 'Persistent BleedBox editing changed an ordinary page render.', 502);
      }
    }
  }
  await assertPdfKitWorkspace(workspace, [...PDFKIT_WORKSPACE_AFTER_FILES, ...validationFiles].sort());
  await assertPdfKitFileIdentity(outputPath, outputIdentity);
  if (await digestFile(outputPath) !== beforeValidationDigest) fail('PDFKIT_OUTPUT_INVALID', 'The PDFKit output changed during independent validation.', 502);
  await assertPdfKitFileIdentity(requestPath, requestIdentity);
  try {
    await assertPrivateSourceCopy({ path: join(workspace, 'input.pdf'), identity: sourceCopyIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDFKIT_SOURCE_BYTES });
  } catch (error) { throw new HostError('SOURCE_INTEGRITY_FAILED', 'The private PDFKit source copy changed during independent validation.', 500, { cause: error }); }
  if (await digestFile(requestPath) !== requestDigest) fail('PDFKIT_WORKSPACE_INVALID', 'The PDFKit helper inputs changed during validation.', 502);
  await store.verifySource(documentId);
  return Object.freeze({ outputInspection, outputDigest: beforeValidationDigest });
}
