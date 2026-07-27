import test from 'node:test';
import * as fixture from './support/host-pdf-service-fixture.js';

const {
  access, assert, assertWorkspaceQuota, convertSignatureContentsToDer, createReadStream,
  decodePng, DocumentStore, EngineRegistry, encodeRgbaPng, execFileAsync,
  executeOfflineSignatureInspection, HostError, join, link, makeInspectionPdf,
  makeMultiPagePdf, makePdfsigOutput, makeTextPdf, measureWorkspaceBytes, mkdir,
  mkdtemp, nativePackageRoot, OcrImageAdapter, parseAttachments, parseCustomMetadata,
  parseDocumentUrls, parseFonts, parseImages, parseNamedDestinations, parsePageBoxes,
  parsePageDimensions, parsePdfInfo, parseSignatures, parseTaggedStructure,
  parseTesseractLanguages, parseTesseractTsv, parseTextPages, PdfService,
  POPPLER_DESTINATION_HEADER, PopplerAdapter, projectRoot, readFile, Readable, rename,
  rm, SignatureTrustAdapter, stageSignatureTrustHelper, symlink, TesseractAdapter, tmpdir,
  validateAltoEvidence, validateOcrBatchManifest, validateOcrDocumentResult,
  validateOcrLayoutResult, validatePages, verifyStagedSignatureTrustHelper, writeFile,
} = fixture;

test('ALTO evidence requires one passive bounded document envelope and carries an exact digest', () => {
  const xml = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><alto xmlns="http://www.loc.gov/standards/alto/ns-v3#"><Layout><Page WIDTH="1" HEIGHT="1"></Page></Layout></alto>');
  const evidence = validateAltoEvidence(xml);
  assert.equal(evidence.byteLength, xml.length);
  assert.equal(evidence.data, xml.toString('base64'));
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => validateAltoEvidence(Buffer.from('<?xml version="1.0"?><!DOCTYPE alto SYSTEM "file:///etc/passwd"><alto><Layout><Page/></Layout></alto>')), { code: 'INVALID_ENGINE_OUTPUT' });
  assert.throws(() => validateAltoEvidence(Buffer.from('<wrapper><alto><Layout><Page/></Layout></alto></wrapper>')), { code: 'INVALID_ENGINE_OUTPUT' });
  assert.throws(() => validateAltoEvidence(Buffer.from('<alto><Page/></alto>')), { code: 'INVALID_ENGINE_OUTPUT' });
});

