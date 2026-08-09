import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { readRegularOutput } from './bounded-output-io.mjs';
import { runConversionJob } from './conversion-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { parsePageDimensions, parsePdfInfo } from './pdf-service-foundation.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { cadEntitiesToPdf } from './professional-capability/cad-geometry.mjs';

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_ENTITIES = 2_000;
const MAX_POINTS = 14_400;
const SHA256 = /^[a-f0-9]{64}$/u;

function invalid(code, message, status = 422) {
  throw new HostError(code, message, status);
}

function cancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error('CAD-to-PDF validation was cancelled.');
  error.code = 'ENGINE_CANCELLED';
  throw error;
}

function exactDxfLines(bytes) {
  if (bytes.includes(0)) invalid('INVALID_CAD_INPUT', 'DXF input must not contain NUL bytes.', 415);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || text.startsWith('\uFEFF')) {
    invalid('INVALID_CAD_INPUT', 'DXF input must be strict UTF-8 without a byte-order mark.', 415);
  }
  if (!text.endsWith('\n') && !text.endsWith('\r')) {
    invalid('INVALID_CAD_INPUT', 'DXF input must end with a record line ending.', 415);
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  if (lines.some((line) => line.includes('\r') || line === '')) {
    invalid('INVALID_CAD_INPUT', 'DXF records must be non-empty CRLF or LF line pairs.', 415);
  }
  if (lines.length % 2 !== 0) invalid('INVALID_CAD_INPUT', 'DXF contains an incomplete group-code pair.', 415);
  return lines;
}

function number(value, label) {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) {
    invalid('INVALID_CAD_GEOMETRY', `${label} must be a non-negative finite decimal coordinate.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed > MAX_POINTS) {
    invalid('INVALID_CAD_GEOMETRY', `${label} must be between 0 and ${MAX_POINTS}.`);
  }
  return parsed;
}

function parseDxfLineSubset(bytes) {
  const lines = exactDxfLines(bytes);
  const pairs = [];
  for (let index = 0; index < lines.length; index += 2) {
    if (!/^[0-9]+$/u.test(lines[index])) invalid('INVALID_CAD_INPUT', 'DXF group codes must be unsigned decimal integers.', 415);
    pairs.push([Number(lines[index]), lines[index + 1]]);
  }
  let cursor = 0;
  const take = (code, value) => {
    const pair = pairs[cursor++];
    if (!pair || pair[0] !== code || pair[1] !== value) {
      invalid('INVALID_CAD_INPUT', 'DXF must contain only one exact ENTITIES section with LINE records.', 415);
    }
  };
  take(0, 'SECTION'); take(2, 'ENTITIES');
  const entities = [];
  while (cursor < pairs.length && pairs[cursor][0] === 0 && pairs[cursor][1] === 'LINE') {
    cursor += 1;
    const coordinates = Object.create(null);
    while (cursor < pairs.length && pairs[cursor][0] !== 0) {
      const [code, value] = pairs[cursor++];
      const key = ({ 10: 'x1', 20: 'y1', 11: 'x2', 21: 'y2' })[code];
      if (!key || Object.hasOwn(coordinates, key)) {
        invalid('INVALID_CAD_INPUT', 'DXF LINE records may contain each required coordinate exactly once.', 415);
      }
      coordinates[key] = number(value, `LINE group ${code}`);
    }
    if (!['x1', 'y1', 'x2', 'y2'].every((key) => Object.hasOwn(coordinates, key))) {
      invalid('INVALID_CAD_INPUT', 'DXF LINE records require 10, 20, 11, and 21 coordinates.', 415);
    }
    entities.push(coordinates);
    if (entities.length > MAX_ENTITIES) invalid('CAD_ENTITY_LIMIT', 'DXF input is limited to 2,000 LINE entities.', 413);
  }
  if (!entities.length) invalid('EMPTY_CAD_GEOMETRY', 'DXF input must contain at least one LINE entity.');
  take(0, 'ENDSEC'); take(0, 'EOF');
  if (cursor !== pairs.length) invalid('INVALID_CAD_INPUT', 'DXF contains unsupported trailing material.', 415);
  return Object.freeze(entities.map((entry) => Object.freeze({ type: 'line', ...entry })));
}

function assertCadAsset(asset) {
  if (!asset || asset.kind !== 'cad' || asset.extension !== '.dxf'
    || asset.mediaType !== 'image/vnd.dxf' || !Number.isSafeInteger(asset.size)
    || asset.size < 5 || asset.size > MAX_SOURCE_BYTES || !SHA256.test(asset.sha256 ?? '')) {
    invalid('UNSUPPORTED_CAD_INPUT', 'CAD-to-PDF accepts only bounded image/vnd.dxf DXF input.', 415);
  }
}

function options(workspace, signal, bytes) {
  return { cwd: workspace, signal, stdin: bytes, maxStdinBytes: MAX_PDF_BYTES,
    timeoutMs: 20_000, maxStdoutBytes: 512 * 1024, maxStderrBytes: 128 * 1024 };
}

function passive(inspection) {
  return inspection?.encrypted === 'no' && inspection.javascript === 'no' && inspection.form === 'none';
}

function assertProvenance(source) {
  const op = source?.operation;
  const input = op?.inputs?.[0];
  const parameters = op?.parameters;
  const valid = source?.origin === 'derived' && source.mediaType === 'application/pdf'
    && Number.isSafeInteger(source.size) && source.size >= 5 && source.size <= MAX_PDF_BYTES
    && SHA256.test(source.sha256 ?? '') && op?.type === 'cad-to-pdf'
    && op.inputs?.length === 1 && Object.keys(input ?? {}).length === 3
    && input?.role === 'source' && typeof input.assetId === 'string'
    && SHA256.test(input.sha256 ?? '') && parameters && Object.keys(parameters).length === 6
    && parameters.sourceFormat === 'dxf' && parameters.sourceKind === 'cad'
    && parameters.conversionMode === 'platen-dxf-line-subset'
    && Number.isSafeInteger(parameters.entityCount) && parameters.entityCount >= 1
    && parameters.entityCount <= MAX_ENTITIES && parameters.widthPoints === 612
    && parameters.heightPoints === 792 && op.expected?.pageCount === 1
    && Object.keys(op.expected ?? {}).length === 1 && Object.keys(op.validation ?? {}).length === 3
    && op.validation?.passed === true && op.validation.pageCount === 1
    && Array.isArray(op.validation.validators) && op.validation.validators.length === 3
    && op.validation.validators[0] === 'source-sha256'
    && op.validation.validators[1] === 'platen-dxf-line-subset-renderer'
    && op.validation.validators[2] === 'pdfinfo-page-count';
  if (!valid) invalid('INVALID_CAD_PDF_DOCUMENT', 'Only an exact Platen DXF LINE-subset PDF can be exported.', 403);
  return parameters;
}

async function stagedBytes({ documents, documentId, source, input, signal }) {
  await documents.verifySource(documentId);
  let identity;
  try {
    identity = await stagePrivateSourceCopy({ sourcePath: documents.getSourcePath(documentId), targetPath: input,
      expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_BYTES, signal });
    const bytes = await readRegularOutput(input, { minimumBytes: 5, maximumBytes: MAX_PDF_BYTES, label: 'CAD PDF snapshot' });
    if (bytes.length !== source.size || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
      invalid('SOURCE_INTEGRITY_FAILED', 'CAD PDF snapshot does not match the derived document.', 500);
    }
    await assertPrivateSourceCopy({ path: input, identity, expectedSha256: source.sha256,
      expectedSize: source.size, maximumBytes: MAX_PDF_BYTES });
    return { bytes, identity };
  } catch (error) {
    if (error instanceof HostError || signal?.aborted) throw error;
    throw new HostError('SOURCE_INTEGRITY_FAILED', 'CAD PDF snapshot could not be staged safely.', 500, { cause: error });
  }
}

export async function createCadPdfDocument({ inputs, documents, poppler, assetId, externalSignal }) {
  const asset = inputs.getInput(assetId);
  assertCadAsset(asset);
  const owner = Object.freeze({ createJobWorkspace: inputs.createJobWorkspace.bind(inputs), cleanupJob: inputs.cleanupJob.bind(inputs),
    verifySource: inputs.verifyInput.bind(inputs), deleteDocument: documents.deleteDocument.bind(documents) });
  return runConversionJob({ owner, resourceId: assetId, externalSignal,
    action: async ({ workspace, signal, checkQuota, registerPromotedDocument }) => {
      const staged = join(workspace, 'immutable-source.dxf');
      await inputs.verifyInput(assetId);
      const identity = await stagePrivateSourceCopy({ sourcePath: inputs.getSourcePath(assetId), targetPath: staged,
        expectedSha256: asset.sha256, expectedSize: asset.size, maximumBytes: MAX_SOURCE_BYTES, signal });
      const source = await readRegularOutput(staged, { minimumBytes: 5, maximumBytes: MAX_SOURCE_BYTES, label: 'CAD DXF snapshot' });
      await assertPrivateSourceCopy({ path: staged, identity, expectedSha256: asset.sha256, expectedSize: asset.size, maximumBytes: MAX_SOURCE_BYTES });
      if (createHash('sha256').update(source).digest('hex') !== asset.sha256) invalid('SOURCE_INTEGRITY_FAILED', 'CAD source changed during staging.', 500);
      const entities = parseDxfLineSubset(source); cancelled(signal);
      const pdf = cadEntitiesToPdf(entities, { widthPoints: 612, heightPoints: 792, title: asset.displayName });
      const inspection = parsePdfInfo((await poppler.execute('inspectStdin', {}, options(workspace, signal, pdf.bytes))).stdout);
      const geometry = parsePageDimensions((await poppler.execute('inspectPageStdin', { page: 1 }, options(workspace, signal, pdf.bytes))).stdout, 1);
      if (inspection.pageCount !== 1 || !passive(inspection) || geometry.widthPoints !== 612 || geometry.heightPoints !== 792) {
        invalid('INVALID_CAD_PDF_DOCUMENT', 'CAD renderer did not produce one passive 612 by 792 point PDF page.', 502);
      }
      await checkQuota(); await inputs.verifyInput(assetId); cancelled(signal);
      const operation = createOperationProvenance({ type: 'cad-to-pdf', inputs: [{ assetId, sha256: asset.sha256, role: 'source' }],
        parameters: { sourceFormat: 'dxf', sourceKind: 'cad', conversionMode: 'platen-dxf-line-subset', entityCount: entities.length, widthPoints: 612, heightPoints: 792 },
        expected: { pageCount: 1 }, validation: { passed: true, validators: ['source-sha256', 'platen-dxf-line-subset-renderer', 'pdfinfo-page-count'], pageCount: 1 } });
      const document = await documents.createDocument({ stream: Readable.from([pdf.bytes]),
        displayName: `${asset.displayName.slice(0, -4)}.pdf`, operation });
      registerPromotedDocument(document); return document;
    } });
}

export async function prepareCadPdfDocumentExport({ documents, poppler, documentId, externalSignal }) {
  const source = documents.getDocument(documentId); const parameters = assertProvenance(source);
  return runConversionJob({ owner: documents, resourceId: documentId, externalSignal,
    action: async ({ workspace, signal, checkQuota }) => {
      const input = join(workspace, 'immutable-cad-pdf.pdf');
      const staged = await stagedBytes({ documents, documentId, source, input, signal });
      const { bytes, identity } = staged;
      const inspection = parsePdfInfo((await poppler.execute('inspectStdin', {}, options(workspace, signal, bytes))).stdout);
      const pageGeometry = parsePageDimensions((await poppler.execute('inspectPageStdin', { page: 1 }, options(workspace, signal, bytes))).stdout, 1);
      if (inspection.pageCount !== 1 || !passive(inspection) || pageGeometry.widthPoints !== 612 || pageGeometry.heightPoints !== 792) {
        invalid('INVALID_CAD_PDF_DOCUMENT', 'CAD PDF export requires one passive 612 by 792 point page.', 502);
      }
      cancelled(signal); await checkQuota(); await assertPrivateSourceCopy({ path: input, identity,
        expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_BYTES });
      await documents.verifySource(documentId); cancelled(signal);
      return Object.freeze({ bytes, inspection: Object.freeze({ pageCount: 1, encrypted: 'no', javascript: 'no', form: 'none' }),
        pageGeometry: Object.freeze({ page: 1, widthPoints: 612, heightPoints: 792 }), entityCount: parameters.entityCount,
        passiveIndicators: Object.freeze({ encrypted: 'no', javascript: 'no', form: 'none' }) });
    } });
}
