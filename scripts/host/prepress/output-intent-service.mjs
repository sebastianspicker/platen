import { createHash } from 'node:crypto';
import { chmod, open } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from '../host-error.mjs';
import { createOperationProvenance } from '../operation-provenance.mjs';
import { fail } from './prepress-support.mjs';
import { normalizeOutputIntentRequest } from './output-intent-contract.mjs';
import {
  inspectPdfOutputIntent,
  writePdfOutputIntent,
} from './output-intent-writer.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_PROFILE_BYTES = 4 * 1024 * 1024;

function sourceDigest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function writePrivate(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o400);
  } finally { await handle.close(); }
  await chmod(path, 0o400);
}

function checkedCore(core) {
  const required = ['withSource', 'assertArtifactStack', 'assertArtifactSource', 'assertInventory', 'readBoundedFile', 'validateDerivedPdf'];
  if (!core || required.some((name) => typeof core[name] !== 'function')
    || !core.profiles || typeof core.profiles.stageDefaultCmyk !== 'function'
    || !core.store || typeof core.store.promotePdfArtifact !== 'function') {
    throw new TypeError('PdfOutputIntentService requires a PrepressServiceCore with ICC staging and artifact promotion.');
  }
  return core;
}

function outputIntentProvenance({ documentId, source, profile, proof, validation }) {
  return createOperationProvenance({
    type: 'ghostscript-cmyk-output-intent',
    inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
    parameters: {
      profileId: profile.id,
      profileSha256: profile.sha256,
      profileBytes: profile.size,
      outputIntentSubtype: 'GTS_PDFX',
      closedClassicRevision: proof.closedClassicRevision,
      priorRevisionsAbsent: proof.priorRevisionsAbsent,
    },
    expected: {
      pageCount: validation.pageCount,
      outputIntentCount: 1,
      embeddedProfileSha256: profile.sha256,
      pdfXValidated: false,
    },
    validation: {
      passed: true,
      validators: [
        'source-sha256', 'icc-header-and-tags', 'icc-profile-sha256',
        'output-intent-structure', 'closed-classic-rewrite', 'poppler-page-count',
        'poppler-page-boxes', 'poppler-passive-content',
        'poppler-text-equivalence', 'poppler-render-all-pages', 'artifact-sha256',
      ],
      outputSha256: validation.outputSha256,
      pageCount: validation.pageCount,
      textSha256: validation.textSha256,
      outputIntentCount: proof.outputIntentCount,
      profileSha256: proof.profileSha256,
    },
  });
}

/** Creates the bounded host operation used by the prepress facade. */
export function createOutputIntentOperation(core) {
  const checked = checkedCore(core);
  return async function assignOutputIntent(documentId, request, { signal } = {}) {
    const { sourceSha256 } = normalizeOutputIntentRequest(request);
    const document = checked.store.getDocument(documentId);
    if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== document.sha256) {
      throw new HostError('SOURCE_VERSION_MISMATCH', 'The OutputIntent source digest does not match the current document.', 409);
    }
    checked.assertArtifactStack({ icc: true });
    return checked.withSource(documentId, signal, async ({
      document: sourceDocument, sourcePath, info, workspace, signal: jobSignal, checkWorkspace,
    }) => {
      checked.assertArtifactSource(info);
      const structure = await checked.artifactStructure(documentId, info.pageCount, jobSignal);
      const sourceBytes = await checked.readBoundedFile(sourcePath, checked.limits.maxDerivedPdfBytes);
      if (sourceDigest(sourceBytes) !== sourceDocument.sha256) fail('SOURCE_INTEGRITY_FAILED', 'The private OutputIntent source copy changed before assignment.', 500);
      const staged = await checked.profiles.stageDefaultCmyk(workspace);
      await checkWorkspace();
      const profileBytes = await checked.readBoundedFile(staged.path, MAX_PROFILE_BYTES);
      if (profileBytes.length !== staged.descriptor.size || sourceDigest(profileBytes) !== staged.descriptor.sha256) {
        fail('ICC_PROFILE_CHANGED', 'The staged Ghostscript CMYK profile changed before assignment.', 502);
      }
      const written = writePdfOutputIntent(sourceBytes, { bytes: profileBytes, descriptor: staged.descriptor });
      const outputPath = join(workspace, 'output-intent.pdf');
      await writePrivate(outputPath, written.bytes);
      await checkWorkspace();
      await checked.assertInventory(workspace, new Set(['source.pdf', 'default-cmyk.icc', 'output-intent.pdf']));
      const outputBytes = await checked.readBoundedFile(outputPath, checked.limits.maxDerivedPdfBytes);
      const proof = inspectPdfOutputIntent({ sourceBytes, outputBytes, stagedProfile: { bytes: profileBytes, descriptor: staged.descriptor } });
      const validation = await checked.validateDerivedPdf({
        sourcePath, outputPath, expectedPageCount: info.pageCount,
        expectedPageBoxes: structure.pageBoxes, workspace,
        allowedFiles: ['source.pdf', 'default-cmyk.icc', 'output-intent.pdf'], signal: jobSignal,
      });
      const outputSha256 = sourceDigest(outputBytes);
      if (outputSha256 !== proof.outputSha256 || outputSha256 !== validation.outputSha256) {
        fail('PREPRESS_OUTPUT_CHANGED', 'The OutputIntent output changed between structural and prepress validation.', 502);
      }
      await checkWorkspace();
      await checked.store.verifySource(documentId);
      const artifact = await checked.store.promotePdfArtifact(documentId, outputPath, {
        displayName: `${String(sourceDocument.displayName ?? 'document').replace(/\.pdf$/iu, '')}-output-intent.pdf`,
        operation: outputIntentProvenance({
          documentId,
          source: sourceDocument,
          profile: staged.descriptor,
          proof,
          validation,
        }),
        expectedSha256: outputSha256,
        signal: jobSignal,
      });
      if (artifact.sha256 !== outputSha256) fail('PREPRESS_ARTIFACT_CHANGED', 'The promoted OutputIntent artifact did not match the validated output.', 500);
      return Object.freeze({
        kind: 'output-intent-artifact', schemaVersion: 1,
        sourceDigest: sourceDocument.sha256, artifact, profile: staged.descriptor,
        proof, receipt: Object.freeze({
          outputSha256, pageCount: validation.pageCount,
          pageGeometryPreserved: true, textExtractionEquivalent: true,
          everyPageRendered: true, outputIntentCount: 1,
          pdfXValidated: false,
        }), authoritative: false,
        limitations: Object.freeze([proof.limitation]),
      });
    });
  };
}

export class PdfOutputIntentService {
  #assign;
  constructor({ core } = {}) { this.#assign = createOutputIntentOperation(core); }
  assign(documentId, request, { signal } = {}) {
    return this.#assign(documentId, request, { signal });
  }
  assignOutputIntent(documentId, request, options) { return this.assign(documentId, request, options); }
}
