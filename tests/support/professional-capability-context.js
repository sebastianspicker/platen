import { createHash } from 'node:crypto';
import { createBlankPdf, createTextPdf } from '../../scripts/host/pdf-factory.mjs';
import {
  redactionFixture,
  signatureFixture,
  formFixture,
  editableTextPdf,
} from '../../scripts/host/professional-capability/fixtures.mjs';
import { pngFixture, psFixture, cadFixture, printerMarksFixture } from './professional-capability-delivery-fixtures.js';
import { scanAppendContext, scanDuplexContext } from './professional-capability-scan-contexts.js';

export function deterministicColorConversionContext(sourcePdf, documentId) {
  const sourceSha256 = createHash('sha256').update(sourcePdf).digest('hex');
  const calls = [];
  return {
    documentId, sourcePdf, sourceBytes: sourcePdf, sourceSha256,
    profile: 'ghostscript-default-cmyk', deterministicColorConversionCalls: calls,
    prepress: Object.freeze({
      convertToCmyk: async (requestedDocumentId, options) => {
        calls.push(Object.freeze({ documentId: requestedDocumentId, options: Object.freeze({ ...options }) }));
        if (requestedDocumentId !== documentId || options?.profile !== 'ghostscript-default-cmyk') throw new Error('The deterministic color-conversion service received an invalid request.');
        const outputSha256 = createHash('sha256').update(`deterministic-cmyk-artifact-v1\0${documentId}\0${sourceSha256}`).digest('hex');
        return Object.freeze({
          kind: 'icc-cmyk-artifact', schemaVersion: 1, sourceDigest: sourceSha256,
          artifact: Object.freeze({ id: `deterministic-cmyk-${outputSha256.slice(0, 16)}`, documentId, sha256: outputSha256, mediaType: 'application/pdf' }),
          profile: Object.freeze({ id: 'ghostscript-default-cmyk', colorSpace: 'CMYK', description: 'Deterministic service fixture; no ICC engine was executed.' }),
          recipe: Object.freeze({ colorConversionStrategy: 'CMYK' }),
          receipt: Object.freeze({ engine: Object.freeze({ name: 'deterministic-prepress-service-fixture', version: 'not-executed' }) }),
          authoritative: false,
          limitations: Object.freeze(['Deterministic service fixture; Ghostscript is not executed.']),
          serviceEvidence: Object.freeze({ deterministicServiceFixture: true, ghostscriptExecuted: false }),
        });
      },
    }),
  };
}

function createBaseContext(id, blank) {
  return {
    deterministic: true, seed: id, pages: 1, title: 'evidence',
    text: 'Evidence alpha beta. Contract value is $12,000. Email j.doe@example.com on 2026-07-01. Chapter One',
    question: 'What is the contract value?', sourcePdf: blank, sourceBytes: blank, inputBytes: blank,
    leftText: 'alpha beta gamma', rightText: 'alpha delta gamma', html: '<p>Hello evidence</p>', clipboardText: 'clipboard evidence',
    jobName: 'job-evidence', postscript: psFixture.toString('latin1'), parts: ['A', 'B'],
    entities: [{ type: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }], rows: [['k', 'v'], ['1', '2']], slides: ['S1', 'S2'], regionText: 'region',
    documents: [{ id: 'a', text: 'Safety valve review finds risk.' }, { id: 'b', text: 'Safety valve maintenance overdue.' }],
    files: [{ name: 'a.txt', bytes: Buffer.from('one'), description: 'A' }, { name: 'b.txt', bytes: Buffer.from('two'), description: 'B' }],
    query: 'a.txt', prompt: 'blueprint stamp', claims: ['Contract'], target: 'es', targetLanguage: 'es', instruction: 'highlight risk', body: 'office body', consent: true,
    pngBytes: pngFixture, region: { x: 0, y: 0, width: 1, height: 1 },
    sources: [{ kind: 'text', bytes: Buffer.from('Part A', 'utf8'), extension: '.txt', label: 'A' }, { kind: 'text', bytes: Buffer.from('Part B', 'utf8'), extension: '.txt', label: 'B' }],
    secret: 'secret', value: 'Ada Lovelace', userPassword: 'UserPass12!abc', ownerPassword: 'OwnerPass12!xyz', find: 'hello world', replace: 'HELLO WORLD',
  };
}

function applyBasicInputFixtures(ctx, id) {
  if (id === 'convert.images-to-pdf' || id === 'export.selected-region' || id === 'export.images') Object.assign(ctx, { sourceBytes: pngFixture, pngBytes: pngFixture });
  if (id === 'create.postscript-to-pdf') Object.assign(ctx, { sourceBytes: psFixture, inputBytes: psFixture });
  if (id === 'create.cad-to-pdf') Object.assign(ctx, { sourceBytes: cadFixture, inputBytes: cadFixture });
  if (id === 'create.multiformat-combine') ctx.sources = [{ kind: 'text', bytes: Buffer.from('Alpha', 'utf8'), extension: '.txt' }, { kind: 'text', bytes: Buffer.from('Beta', 'utf8'), extension: '.txt' }];
  if (id.startsWith('sign.')) Object.assign(ctx, { sourcePdf: signatureFixture(), sourceBytes: ctx.sourcePdf });
  if (id === 'sign.identity-verification') {
    ctx.claimedSubject = 'CN=Local Signer';
    ctx.expectedFingerprint = createHash('sha256').update('CN=Local Signer').digest('hex');
  }
  if (id.startsWith('redaction.') || id === 'sanitize.selective-content') {
    const sourcePdf = redactionFixture({ secret: 'secret' });
    Object.assign(ctx, { sourcePdf, sourceBytes: sourcePdf, secret: 'secret' });
  }
  if (id.startsWith('forms.')) {
    const sourcePdf = formFixture();
    Object.assign(ctx, { sourcePdf, sourceBytes: sourcePdf });
  }
  if (id === 'edit.text' || id === 'edit.find-replace' || id === 'edit.text-reflow') {
    const sourcePdf = editableTextPdf('hello world');
    Object.assign(ctx, { sourcePdf, sourceBytes: sourcePdf });
  }
  if (id.startsWith('portfolios.') || id === 'document.embedded-files') delete ctx.sourcePdf;
}

function applySecurityAndViewerFixtures(ctx, id, blank) {
  if (id === 'security.encryption-aes' || id === 'security.open-password' || id === 'security.security-envelopes' || id === 'security.certificate-encryption') {
    ctx.sourcePdf = createTextPdf({ text: 'CONFIDENTIAL-PAYLOAD', title: 'Sensitive' });
    ctx.secret = 'CONFIDENTIAL-PAYLOAD';
  }
  if (id === 'viewer.search' || id === 'viewer.advanced-search') {
    ctx.query = 'Contract';
    ctx.text = 'Evidence alpha beta. Contract value is $12,000. Email j.doe@example.com on 2026-07-01. Chapter One';
  }
  if (id === 'color.convert') {
    delete ctx.target;
    Object.assign(ctx, deterministicColorConversionContext(blank, 'deterministic-color-convert-source'));
  }
}

function applyServiceFixtures(ctx, id, blank) {
  if (id === 'color.output-intents') {
    const outputIntentPdf = Buffer.from('%PDF-1.7\n/OutputIntents [/OutputIntent /GTS_PDFX /N 4]\n%%EOF\n', 'ascii');
    const outputSha256 = createHash('sha256').update(outputIntentPdf).digest('hex');
    const profileSha256 = 'b'.repeat(64);
    ctx.documentId = 'deterministic-output-intent-document';
    ctx.sourceSha256 = createHash('sha256').update(blank).digest('hex');
    ctx.outputIntentArtifactBytes = outputIntentPdf;
    ctx.prepress = {
      async assignOutputIntent(documentId, request) {
        if (documentId !== ctx.documentId || request.profile !== 'local-ghostscript-default-cmyk-output-intent-v1' || request.sourceSha256 !== ctx.sourceSha256) throw new Error('invalid OutputIntent request');
        return {
          kind: 'output-intent-artifact',
          sourceDigest: ctx.sourceSha256,
          artifact: {
            id: 'deterministic-output-intent-artifact', documentId, sha256: outputSha256,
            operation: {
              type: 'ghostscript-cmyk-output-intent',
              inputs: [{ documentId, sha256: ctx.sourceSha256, role: 'source' }],
              parameters: { profileId: 'ghostscript-default-cmyk', profileSha256, profileBytes: 187484, outputIntentSubtype: 'GTS_PDFX' },
              expected: { embeddedProfileSha256: profileSha256, outputIntentCount: 1 },
              validation: { passed: true, outputSha256, profileSha256 },
            },
          },
          profile: { id: 'ghostscript-default-cmyk', colorSpace: 'CMYK', sha256: profileSha256, size: 187484 },
          proof: {
            schema: 'pdf-output-intent-assignment-proof-v1', sourceSha256: ctx.sourceSha256,
            outputSha256, profileSha256, profileBytes: 187484, outputIntentCount: 1,
            closedClassicRevision: true, priorRevisionsAbsent: true,
          },
          receipt: {
            outputSha256, outputIntentCount: 1, pageGeometryPreserved: true,
            textExtractionEquivalent: true, everyPageRendered: true, pdfXValidated: false,
          },
        };
      },
    };
  }
  if (id === 'optimize.compress') {
    ctx.sourcePdf = Buffer.concat([blank, Buffer.alloc(256, 0x20)]);
    ctx.sourceBytes = ctx.sourcePdf;
  }
  if (id === 'print.bleed-marks') Object.assign(ctx, { sourcePdf: printerMarksFixture, sourceBytes: printerMarksFixture });
}

function applyWorkflowFixtures(ctx, id, blank) {
  if (['accessibility.form-semantics', 'accessibility.links-bookmarks', 'accessibility.table-semantics'].includes(id)) {
    delete ctx.sourcePdf;
    delete ctx.sourceBytes;
    ctx.demoFixture = true;
  }
  if (id === 'optimize.fast-web-view') {
    const sourceSha256 = createHash('sha256').update(blank).digest('hex');
    ctx.documentId = 'deterministic-fast-web-view-source';
    ctx.sourceSha256 = sourceSha256;
    ctx.fastWebView = Object.freeze({ linearize: async (documentId, request, options) => {
      if (documentId !== ctx.documentId || request?.profile !== 'local-pdf-fast-web-view-v1' || options?.sourceSha256 !== sourceSha256) throw new Error('The deterministic fast-web-view service received an invalid request.');
      return Object.freeze({ kind: 'pdf-fast-web-view', sourceDigest: sourceSha256, artifact: Object.freeze({ id: 'deterministic-fast-web-view-artifact' }), engine: Object.freeze({ name: 'qpdf', version: 'deterministic-service-fixture' }), evidence: Object.freeze({ qpdfLinearized: true, qpdfCheckLinearization: true, deterministicServiceFixture: true }), limitations: Object.freeze(['deterministic service fixture; qpdf is not executed']) });
    } });
  }
  if (id === 'print.imposition') {
    const sourceSha256 = createHash('sha256').update(blank).digest('hex');
    ctx.documentId = 'deterministic-imposition-source';
    ctx.sourceSha256 = sourceSha256;
    ctx.prepress = Object.freeze({ createImposition: async (documentId, options) => {
      if (documentId !== ctx.documentId || options?.layout !== '2x1' || options?.marks !== false) throw new Error('The deterministic imposition service received an invalid request.');
      return Object.freeze({ kind: 'imposition-artifact', sourceDigest: sourceSha256, artifact: Object.freeze({ id: 'deterministic-imposition-artifact' }), layout: Object.freeze({ id: '2x1', across: 2, down: 1, order: 'upper-left-row-major', sourcePageCount: 2, sheetCount: 1, sourcePage: Object.freeze({ widthPoints: 612, heightPoints: 792 }), sheet: Object.freeze({ widthPoints: 1224, heightPoints: 792 }), marks: 'none' }), receipt: Object.freeze({ engine: Object.freeze({ name: 'Ghostscript', version: 'deterministic-service-fixture' }), outputSha256: 'a'.repeat(64), pageCount: 1, vectorOrientedPdfwriteRewrite: true, unconditionalVectorPreservationClaim: false, textExtractionEquivalent: true, everySheetRendered: true, pdfXValidated: false }), authoritative: false, limitations: Object.freeze(['deterministic service fixture; Ghostscript is not executed']) });
    } });
  }
}

function applyFinalWorkflowFixtures(ctx, id, blank) {
  if (id === 'scan.append-to-document') {
    const fixture = scanAppendContext();
    const getDocument = fixture.store.getDocument.bind(fixture.store);
    const getArtifact = fixture.store.getArtifact.bind(fixture.store);
    fixture.store.getDocument = (documentId) => {
      const record = getDocument(documentId);
      return {
        id: record.id,
        displayName: record.id === fixture.primaryDocumentId ? 'base.pdf' : 'scan.pdf',
        mediaType: record.mediaType,
        size: record.size,
        sha256: record.sha256,
        origin: 'uploaded',
        operation: null,
        createdAt: '2026-07-27T00:00:00.000Z',
      };
    };
    fixture.store.getArtifact = (artifactId) => ({
      displayName: 'scan-append-output.pdf',
      ...getArtifact(artifactId),
    });
    Object.assign(ctx, fixture);
  }
  if (id === 'scan.duplex-feeder') {
    const fixture = scanDuplexContext();
    const getDocument = fixture.store.getDocument.bind(fixture.store);
    fixture.store.getDocument = (documentId) => {
      const record = getDocument(documentId);
      return {
        id: record.id,
        displayName: 'duplex-scan.pdf',
        mediaType: record.mediaType,
        size: record.size,
        sha256: record.sha256,
        origin: 'derived',
        operation: record.operation,
        createdAt: '2026-07-27T00:00:00.000Z',
      };
    };
    Object.assign(ctx, fixture, { sheets: 2, sides: 'duplex' });
  }
  if (id === 'print.transparency-flattening') {
    const sourceSha256 = createHash('sha256').update(blank).digest('hex');
    ctx.documentId = 'deterministic-transparency-source';
    ctx.sourceSha256 = sourceSha256;
    ctx.conversion = Object.freeze({ rewriteDocument: async (documentId, mode) => {
      if (documentId !== ctx.documentId || mode !== 'flatten-transparency') throw new Error('The deterministic transparency service received an invalid request.');
      return Object.freeze({ id: 'deterministic-transparency-output', sha256: 'b'.repeat(64), size: 1024, operation: Object.freeze({ type: 'flatten-transparency', inputs: Object.freeze([{ documentId, sha256: sourceSha256, role: 'primary' }]), validation: Object.freeze({ passed: true, pageCount: 1 }) }) });
    } });
  }
}

function applyAnnotationAndAccessibilityFixtures(ctx, id, blank) {
  if (id === 'review.annotation-flatten') {
    const sourceSha256 = createHash('sha256').update(blank).digest('hex');
    const flattenRequest = Object.freeze({ profile: 'local-square-annotation-flatten-v1', sourceSha256, target: Object.freeze({ page: 1, annotationIndex: 0, fingerprint: 'c'.repeat(64), subtype: 'square' }) });
    ctx.documentId = 'deterministic-annotation-flatten-source';
    ctx.sourceSha256 = sourceSha256;
    ctx.flattenRequest = flattenRequest;
    ctx.annotationFlatten = Object.freeze({ flatten: async (documentId, request, options) => {
      if (documentId !== ctx.documentId || request !== flattenRequest || options?.sourceSha256 !== sourceSha256) throw new Error('The deterministic annotation-flatten service received an invalid request.');
      return Object.freeze({ kind: 'pdf-square-annotation-flatten', sourceDigest: sourceSha256, artifact: Object.freeze({ id: 'deterministic-annotation-flatten-artifact' }), flatten: Object.freeze({ profile: flattenRequest.profile, page: 1, annotationIndex: 0, subtype: 'square' }), evidence: Object.freeze({ sourceDigestReverified: true, locatorRederived: true, normalAppearanceVerified: true, appearancePromotedToPageContent: true, annotationRemoved: true, removedReferenceUnresolvable: true, closedClassicRevision: true, priorRevisionsAbsent: true, pageCountMatched: true, pageTextMatched: true, pageBoxesMatched: true, pageValidationRendersMatched: true, outputUnsigned: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true }), limitations: Object.freeze(['deterministic service fixture; Poppler is not executed']) });
    } });
  }
  if (id.startsWith('aec.')) {
    delete ctx.sourcePdf;
    delete ctx.sourceBytes;
  }
}

export function contextFor(id) {
  const blank = createBlankPdf({ pages: 1, title: 'evidence' });
  const ctx = createBaseContext(id, blank);
  applyBasicInputFixtures(ctx, id);
  applySecurityAndViewerFixtures(ctx, id, blank);
  applyServiceFixtures(ctx, id, blank);
  applyWorkflowFixtures(ctx, id, blank);
  applyFinalWorkflowFixtures(ctx, id, blank);
  applyAnnotationAndAccessibilityFixtures(ctx, id, blank);
  return ctx;
}
