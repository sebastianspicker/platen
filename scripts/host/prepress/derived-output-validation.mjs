import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePageBoxes, parsePdfInfo } from '../pdf-service-foundation.mjs';
import {
  assertPng,
  digest,
  digestFile,
  fail,
  normalizedText,
  pageGeometryMatches,
} from './prepress-support.mjs';

function assertDerivedPdfInfo(inspected, expectedPageCount) {
  if (inspected.pageCount !== expectedPageCount ||
    String(inspected.encrypted).toLowerCase() !== 'no' ||
    String(inspected.form).toLowerCase() !== 'none' ||
    String(inspected.javascript).toLowerCase() !== 'no') {
    fail('PREPRESS_DERIVED_PDF_INVALID', 'The derived prepress PDF changed page count or passive-content safety state.', 502);
  }
}

function assertExpectedGeometry(parsedBoxes, expectedPageBoxes, expectedSheet) {
  if (expectedPageBoxes && (expectedPageBoxes.length !== parsedBoxes.length ||
    parsedBoxes.some((item, index) => !pageGeometryMatches(expectedPageBoxes[index], item)))) {
    fail('PREPRESS_PAGE_GEOMETRY_CHANGED', 'The CMYK rewrite changed source page geometry.', 502);
  }
  if (expectedSheet && parsedBoxes.some((item) => item.rotation !== 0 ||
    Math.abs(item.widthPoints - expectedSheet.widthPoints) > 0.01 ||
    Math.abs(item.heightPoints - expectedSheet.heightPoints) > 0.01 ||
    Math.abs(item.boxes.mediaBox.left) > 0.01 ||
    Math.abs(item.boxes.mediaBox.bottom) > 0.01 ||
    Math.abs(item.boxes.mediaBox.right - expectedSheet.widthPoints) > 0.01 ||
    Math.abs(item.boxes.mediaBox.top - expectedSheet.heightPoints) > 0.01)) {
    fail('IMPOSITION_OUTPUT_GEOMETRY_INVALID', 'The N-up output sheet geometry did not match the fixed layout.', 502);
  }
}

async function assertTextEquivalent(core, sourcePath, outputPath, options) {
  const textOptions = { ...options, timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024 };
  const [sourceText, outputText] = await Promise.all([
    core.poppler.execute('extractText', { input: sourcePath, layout: true }, textOptions),
    core.poppler.execute('extractText', { input: outputPath, layout: true }, textOptions),
  ]);
  const sourceNormalized = normalizedText(sourceText.stdout);
  if (sourceNormalized !== normalizedText(outputText.stdout)) {
    fail('PREPRESS_TEXT_EQUIVALENCE_FAILED', 'The derived prepress PDF did not preserve normalized extracted text.', 502);
  }
  return sourceNormalized;
}

async function renderEveryPage(core, outputPath, expectedPageCount, workspace, options) {
  for (let pageNumber = 1; pageNumber <= expectedPageCount; pageNumber += 1) {
    const prefix = join(workspace, `validation-${pageNumber}`);
    const path = `${prefix}.png`;
    await core.poppler.execute('renderPagePng', {
      input: outputPath,
      outputPrefix: prefix,
      page: pageNumber,
      maxDimension: 256,
    }, {
      ...options,
      timeoutMs: 30_000,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 128 * 1024,
    });
    assertPng(await core.readBoundedFile(path, core.limits.maxPreviewBytes), core.limits);
    await unlink(path);
  }
}

/** Validates a retained PDF before it is eligible for artifact promotion. */
export async function validateDerivedPdf(core, {
  sourcePath,
  outputPath,
  expectedPageCount,
  expectedPageBoxes = null,
  expectedSheet = null,
  workspace,
  allowedFiles,
  signal,
}) {
  const metadata = await core.assertRegular(outputPath);
  if (metadata.size < 1 || metadata.size > core.limits.maxDerivedPdfBytes) {
    fail('PREPRESS_OUTPUT_LIMIT', 'The derived prepress PDF exceeds the local output limit.', 413);
  }
  const outputSha256 = await digestFile(outputPath);
  const options = {
    cwd: workspace,
    signal,
    timeoutMs: 30_000,
    maxStderrBytes: 256 * 1024,
  };
  const inspected = parsePdfInfo((await core.poppler.execute('inspect', { input: outputPath }, {
    ...options,
    maxStdoutBytes: 512 * 1024,
  })).stdout);
  assertDerivedPdfInfo(inspected, expectedPageCount);
  const parsedBoxes = parsePageBoxes((await core.poppler.execute('inspectPageBoxes', {
    input: outputPath,
    firstPage: 1,
    lastPage: expectedPageCount,
  }, { ...options, maxStdoutBytes: 4 * 1024 * 1024 })).stdout, {
    firstPage: 1,
    lastPage: expectedPageCount,
  });
  assertExpectedGeometry(parsedBoxes, expectedPageBoxes, expectedSheet);
  const sourceNormalized = await assertTextEquivalent(core, sourcePath, outputPath, options);
  await renderEveryPage(core, outputPath, expectedPageCount, workspace, options);
  await core.assertInventory(workspace, new Set(allowedFiles));
  if (await digestFile(outputPath) !== outputSha256) {
    fail('PREPRESS_DERIVED_PDF_CHANGED', 'The derived prepress PDF changed during validation.', 502);
  }
  return Object.freeze({
    outputSha256,
    pageCount: inspected.pageCount,
    pageBoxes: parsedBoxes,
    textSha256: digest(Buffer.from(sourceNormalized, 'utf8')),
  });
}
