import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PopplerAdapter } from '../../scripts/host/adapters/poppler.mjs';
import { TesseractAdapter } from '../../scripts/host/adapters/tesseract.mjs';
import { OcrImageAdapter } from '../../scripts/host/adapters/ocr-image.mjs';
import { DocumentStore } from '../../scripts/host/document-store.mjs';
import { EngineRegistry } from '../../scripts/host/engine-registry.mjs';
import { HostError } from '../../scripts/host/host-error.mjs';
import {
  PdfService,
  assertWorkspaceQuota,
  measureWorkspaceBytes,
  parseAttachments,
  parseFonts,
  parseImages,
  parseCustomMetadata,
  parseDocumentUrls,
  parseNamedDestinations,
  parsePageDimensions,
  parsePageBoxes,
  parsePdfInfo,
  parseSignatures,
  parseTaggedStructure,
  parseTesseractLanguages,
  parseTesseractTsv,
  parseTextPages,
  executeOfflineSignatureInspection,
  validateAltoEvidence,
  validatePages,
} from '../../scripts/host/pdf-service.mjs';
import { makeMultiPagePdf, makeTextPdf } from '../pdf-fixture.js';
import { validateOcrBatchManifest, validateOcrDocumentResult, validateOcrLayoutResult } from '../../src/core/ocr-contract.js';
import { decodePng, encodeRgbaPng } from '../../scripts/host/raster-png-codec.mjs';
import { SignatureTrustAdapter } from '../../scripts/host/adapters/signature-trust.mjs';
import {
  stageSignatureTrustHelper,
  verifyStagedSignatureTrustHelper,
} from '../../scripts/host/signature-trust-helper-loader.mjs';

const execFileAsync = promisify(execFile);
const POPPLER_DESTINATION_HEADER = 'Page  Destination                 Name';
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const nativePackageRoot = fileURLToPath(new URL('../../native/pdfkit-helper/', import.meta.url));

function makeInspectionPdf() {
  const metadata = '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><local>offline</local></x:xmpmeta><?xpacket end="w"?>';
  const content = 'BT\n/F1 18 Tf\n72 720 Td\n(Structure probe) Tj\nET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Names << /Dests 8 0 R >> /Metadata 7 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [18 18 594 774] /BleedBox [12 12 600 780] /TrimBox [24 24 588 768] /ArtBox [36 36 576 756] /Resources << /Font << /F1 3 0 R >> >> /Contents 6 0 R /Annots [5 0 R] >>',
    '<< /Type /Annot /Subtype /Link /Rect [72 700 260 730] /A << /S /URI /URI (https://example.test/local) >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    `<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(metadata)} >>\nstream\n${metadata}\nendstream`,
    '<< /Names [(chapter-one) [4 0 R /XYZ 0 792 0]] >>',
    '<< /Title (Inspection Fixture) /Department (Prepress) >>',
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
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 9 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

function makePdfsigOutput({
  input = '/private/source.pdf', validation = 'Signature is Valid.', coverage = 'Total document signed',
  hashAlgorithm = 'SHA-256', commonName = 'Platen Test',
} = {}) {
  return [
    `Digital Signature Info of: ${input}`,
    'Signature #1:',
    '  - Signature Field Name: Signature1',
    `  - Signer Certificate Common Name: ${commonName}`,
    '  - Signer full Distinguished Name: O=Local Fixture,CN=Platen Test',
    '  - Signing Time: Jul 18 2026 23:40:55',
    `  - Signing Hash Algorithm: ${hashAlgorithm}`,
    '  - Signature Type: adbe.pkcs7.detached',
    '  - Signed Ranges: [0 - 1340], [4524 - 4839]',
    `  - ${coverage}`,
    `  - Signature Validation: ${validation}`,
    '',
  ].join('\n');
}

async function convertSignatureContentsToDer(bytes, root, options) {
  const source = bytes.toString('latin1');
  const match = source.match(/\/Contents\s*<([0-9A-Fa-f]+)>/u);
  assert.ok(match, 'signed fixture must contain one hexadecimal signature Contents string');
  assert.equal(match[1].length % 2, 0);
  const padded = Buffer.from(match[1], 'hex');
  const cmsInput = join(root, 'fixture-cms-ber.bin');
  const cmsOutput = join(root, 'fixture-cms-der.bin');
  await writeFile(cmsInput, padded, { mode: 0o600 });
  await execFileAsync('/opt/homebrew/bin/openssl', [
    'cms', '-cmsout', '-inform', 'DER', '-in', cmsInput,
    '-outform', 'DER', '-out', cmsOutput,
  ], options);
  const der = await readFile(cmsOutput);
  assert.ok(der.length > 2 && der.length <= padded.length);
  assert.equal(der[0], 0x30);
  assert.notEqual(der[1], 0x80, 'converted fixture must use definite-length DER');
  const replacement = `${der.toString('hex')}${'0'.repeat((padded.length - der.length) * 2)}`;
  return Buffer.from(source.replace(match[1], replacement), 'latin1');
}

export {
  access,
  assert,
  assertWorkspaceQuota,
  convertSignatureContentsToDer,
  createReadStream,
  decodePng,
  DocumentStore,
  EngineRegistry,
  encodeRgbaPng,
  execFileAsync,
  executeOfflineSignatureInspection,
  HostError,
  join,
  link,
  makeInspectionPdf,
  makeMultiPagePdf,
  makePdfsigOutput,
  makeTextPdf,
  measureWorkspaceBytes,
  mkdir,
  mkdtemp,
  nativePackageRoot,
  OcrImageAdapter,
  parseAttachments,
  parseCustomMetadata,
  parseDocumentUrls,
  parseFonts,
  parseImages,
  parseNamedDestinations,
  parsePageBoxes,
  parsePageDimensions,
  parsePdfInfo,
  parseSignatures,
  parseTaggedStructure,
  parseTesseractLanguages,
  parseTesseractTsv,
  parseTextPages,
  PdfService,
  POPPLER_DESTINATION_HEADER,
  PopplerAdapter,
  projectRoot,
  readFile,
  Readable,
  rename,
  rm,
  SignatureTrustAdapter,
  stageSignatureTrustHelper,
  symlink,
  TesseractAdapter,
  tmpdir,
  validateAltoEvidence,
  validateOcrBatchManifest,
  validateOcrDocumentResult,
  validateOcrLayoutResult,
  validatePages,
  verifyStagedSignatureTrustHelper,
  writeFile,
};
