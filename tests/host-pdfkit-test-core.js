import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, open, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { before, test } from 'node:test';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { makeMultiPagePdf, makeTextPdf } from './pdf-fixture.js';
import { PDFKitAdapter, parsePdfkitResponse } from '../scripts/host/adapters/pdfkit.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { stagePdfKitHelper, verifyStagedPdfKitHelper } from '../scripts/host/pdfkit-helper-loader.mjs';
import { PdfKitSanitizationService } from '../scripts/host/pdfkit-sanitization-service.mjs';
import { createProcessLimiter } from '../scripts/host/process-runner.mjs';

const packageRoot = new URL('../native/pdfkit-helper/', import.meta.url);
const packagePath = fileURLToPath(packageRoot);
const projectPath = fileURLToPath(new URL('../', import.meta.url));
const productPath = fileURLToPath(new URL('.build/debug/pdfkit-inspect', packageRoot));
const limits = { maxPages: 10, maxAnnotationsPerPage: 50, maxWidgetsPerPage: 50, maxOutlineDepth: 8, maxOutlineItems: 10 };

function mutationRequest(mutation, sourceSha256Value) {
  return {
    version: 1, operation: 'mutate', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: sourceSha256Value, limits, mutation,
  };
}

function emptyMutation() {
  return { metadata: null, pageBox: null, annotations: [], rotation: null };
}

function sourceSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function targetedMutationRequest(sourceSha256Value, mutation) {
  return {
    version: 1, operation: 'targetedMutate', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: sourceSha256Value, limits, mutation,
  };
}

function localGoToRequest(sourceSha256Value, link, requestLimits = limits) {
  return {
    version: 1, operation: 'addLocalGoToLink', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: sourceSha256Value, limits: requestLimits, link,
  };
}

function lineAnnotationRequest(sourceSha256Value, line, requestLimits = limits) {
  return {
    version: 1, operation: 'addLineAnnotation', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: sourceSha256Value, limits: requestLimits, line,
  };
}

function inkAnnotationRequest(sourceSha256Value, ink, requestLimits = limits) {
  return {
    version: 1, operation: 'addInkAnnotation', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: sourceSha256Value, limits: requestLimits, ink,
  };
}

function protectionRequest(sourceSha256Value, profile = 'accessibility-only') {
  return {
    version: 1, operation: 'protect', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: sourceSha256Value, limits,
    protection: { profile, ownerPassword: 'Owner-Pass-123', userPassword: 'User-Pass-4567' },
  };
}

function protectionRemovalRequest(sourceSha256Value, sourceProfile = 'accessibility-only', ownerPassword = 'Owner-Pass-123') {
  return {
    version: 1, operation: 'removeProtection', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: sourceSha256Value, limits, removal: { sourceProfile, ownerPassword },
  };
}

function metadataSanitizationRequest(sourceSha256Value) {
  return {
    version: 1, operation: 'sanitizeMetadata', inputFilename: 'input.pdf', outputFilename: 'output.pdf',
    sourceSha256: sourceSha256Value, limits,
  };
}

function makeMetadataSanitizationPdf({ info = null, xmp = false, catalogExtra = '', pageExtra = '' } = {}) {
  const stream = 'BT\n/F1 18 Tf\n72 720 Td\n(metadata sanitization fixture) Tj\nET\n';
  const xmpText = '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>\n';
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${xmp ? ' /Metadata 6 0 R' : ''}${catalogExtra} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R${pageExtra} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    ...(xmp ? [`<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xmpText)} >>\nstream\n${xmpText}endstream`] : []),
    ...(info ? [info] : []),
  ];
  const infoObject = info ? objects.length : null;
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body, 'binary')); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xrefOffset = Buffer.byteLength(body, 'binary'); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${infoObject ? ` /Info ${infoObject} 0 R` : ''} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

function makeLocatorPdf({
  withAction = false, withSignature = false, textFlags = 0, choiceFlags = 0,
  sharedFieldName = false, emptyTextFieldName = false, choiceOptions = ['one', 'two'], choiceInitialValue = 'one',
  choiceWithAction = false, emptyChoiceFieldName = false, hiddenSignature = false, catalogExtra = '', acroFormExtra = '',
} = {}) {
  const stream = 'BT\n/Helv 18 Tf\n72 720 Td\n(locator fixture) Tj\nET\n';
  const textFieldName = emptyTextFieldName ? '' : 'customer-name';
  const choiceFieldName = sharedFieldName ? textFieldName : (emptyChoiceFieldName ? '' : 'local-choice');
  const choiceOptionsPdf = choiceOptions.map((option) => `(${option})`).join(' ');
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /AcroForm 9 0 R${catalogExtra} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /Helv 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R 7 0 R 8 0 R${hiddenSignature ? ' 10 0 R' : ''}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (${textFieldName}) /V (fixture widget value must remain private) /DA (/Helv 12 Tf 0 g) /Rect [72 650 300 680] /P 3 0 R${textFlags ? ` /Ff ${textFlags}` : ''}${withAction ? ' /A << /S /URI /URI (https://example.invalid) >>' : ''} >>`,
    `<< /Type /Annot /Subtype /Widget /FT /${withSignature ? 'Sig' : 'Ch'} /T (${choiceFieldName}) /V (${choiceInitialValue}) /Opt [${choiceOptionsPdf}] /DA (/Helv 12 Tf 0 g) /Rect [72 610 300 640] /P 3 0 R${choiceFlags ? ` /Ff ${choiceFlags}` : ''}${choiceWithAction ? ' /A << /S /URI /URI (https://example.invalid) >>' : ''} >>`,
    '<< /Type /Annot /Subtype /FreeText /Contents (fixture annotation content must remain private) /DA (/Helv 12 Tf 0 g) /Rect [72 550 300 590] /P 3 0 R >>',
    `<< /Fields [6 0 R 7 0 R${hiddenSignature ? ' 10 0 R' : ''}] /NeedAppearances true /DR << /Font << /Helv 4 0 R >> >>${acroFormExtra} >>`,
    ...(hiddenSignature ? ['<< /Type /Annot /Subtype /Widget /FT /Sig /T (hidden-signature) /Rect [0 0 0 0] /P 3 0 R >>'] : []),
  ];
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

function makeTargetedSanitizationPdf({
  targetExtra = '', annotationReferences = '8 0 R 9 0 R', secondPageAnnotationReferences = '10 0 R',
  acroFormObject = '<< /Fields [] >>', extraObjects = [],
} = {}) {
  const first = 'BT\n/Helv 18 Tf\n72 720 Td\n(targeted sanitization source) Tj\nET\n';
  const second = 'BT\n/Helv 18 Tf\n72 720 Td\n(non-target annotation source) Tj\nET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 11 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /Helv 5 0 R >> >> /Contents 6 0 R /Annots [' + annotationReferences + '] >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /Helv 5 0 R >> >> /Contents 7 0 R /Annots [${secondPageAnnotationReferences}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(first)} >>\nstream\n${first}endstream`,
    `<< /Length ${Buffer.byteLength(second)} >>\nstream\n${second}endstream`,
    `<< /Type /Annot /Subtype /FreeText /Contents (private targeted removal contents) /DA (/Helv 12 Tf 0 g) /Rect [72 550 300 590] /P 3 0 R${targetExtra} >>`,
    '<< /Type /Annot /Subtype /Circle /Contents (private retained target-page contents) /Rect [320 550 500 620] /P 3 0 R >>',
    '<< /Type /Annot /Subtype /Square /Contents (private non-target-page contents) /Rect [72 550 300 620] /P 4 0 R >>',
    acroFormObject,
    ...extraObjects,
  ];
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

export { assert, chmod, link, mkdtemp, open, readFile, rm, stat, symlink, unlink, writeFile, tmpdir, join, spawnSync, createHash, Readable, fileURLToPath, makeMultiPagePdf, makeTextPdf, PDFKitAdapter, parsePdfkitResponse, PopplerAdapter, DocumentStore, EngineRegistry, stagePdfKitHelper, verifyStagedPdfKitHelper, PdfKitSanitizationService, createProcessLimiter, packageRoot, packagePath, projectPath, productPath, limits, mutationRequest, emptyMutation, sourceSha256, targetedMutationRequest, localGoToRequest, lineAnnotationRequest, inkAnnotationRequest, protectionRequest, protectionRemovalRequest, metadataSanitizationRequest, makeMetadataSanitizationPdf, makeLocatorPdf, makeTargetedSanitizationPdf };
