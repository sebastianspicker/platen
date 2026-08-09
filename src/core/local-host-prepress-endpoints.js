import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';
import { validatePreflightReviewReport } from './preflight-report-contract.js';
import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const PREPRESS_OPERATIONS = Object.freeze([
  'preflight', 'ink-coverage', 'separations', 'overprint-preview',
]);
const PREFLIGHT_PROFILES = Object.freeze(['print-review', 'archive-review']);
const OUTPUT_INTENT_PROFILE = 'local-ghostscript-default-cmyk-output-intent-v1';
const SHA256 = /^[a-f0-9]{64}$/u;
const ARTIFACT_KEYS = Object.freeze(['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt']);
const OPERATION_KEYS = Object.freeze(['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt']);
const CMYK_LIMITATIONS = Object.freeze([
  'This is CMYK-targeted normalization through an exact local ICC profile, not PDF/X, GWG, Ghent, or press certification.',
  'Ghostscript does not colorimetrically retarget existing DeviceCMYK values; Separation and DeviceN colorants are preserved rather than eliminated.',
  'No PDF OutputIntent is assigned or validated, and complex transparency, optional content, annotations, links, and metadata may be rewritten.',
]);
const IMPOSITION_LIMITATIONS = Object.freeze([
  'This is bounded row-major N-up, not booklet, signature, creep, gutter, step-and-repeat, or production imposition.',
  'Printer marks are unavailable because the installed engine has no validated production marks contract.',
  'Ghostscript writes a new vector-oriented PDF but may rewrite or rasterize unsupported constructs; links, destinations, tags, annotations, forms, optional content, and signatures are not preserved by contract.',
]);
const OUTPUT_INTENT_LIMITATION = 'Assignment records a fixed host-bundled CMYK OutputIntent only; it does not establish PDF/X, colorimetric conformance, press certification, or RIP parity.';

function plain(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(value).every((key) => typeof key === 'string'
      && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
  } catch { return false; }
}

function exact(value, keys) {
  return plain(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function dense(value, minimum = 0, maximum = 64) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < minimum || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return false;
    return Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, index))
      .every((descriptor) => descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true);
  } catch { return false; }
}

function sameData(left, right, active = new Map()) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (active.has(left)) return active.get(left) === right;
  active.set(left, right);
  let equal = false;
  if (Array.isArray(left) || Array.isArray(right)) {
    equal = dense(left, 0, 256) && dense(right, 0, 256) && left.length === right.length
      && left.every((value, index) => sameData(value, right[index], active));
  } else if (plain(left) && plain(right)) {
    const leftKeys = Reflect.ownKeys(left); const rightKeys = Reflect.ownKeys(right);
    equal = leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key)
      && sameData(left[key], right[key], active));
  }
  active.delete(left);
  return equal;
}
function timestamp(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function text(value, maximum = 512) { return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value); }
function positive(value, maximum = 100_000_000) { return Number.isSafeInteger(value) && value > 0 && value <= maximum; }
function engine(value) { return exact(value, ['name', 'version']) && value.name === 'Ghostscript' && text(value.version, 128); }
function profile(value) {
  return exact(value, ['id', 'description', 'version', 'deviceClass', 'colorSpace', 'connectionSpace', 'renderingIntent', 'size', 'sha256', 'tagCount'])
    && value.id === 'ghostscript-default-cmyk' && text(value.description, 256) && text(value.version, 32)
    && value.deviceClass === 'output' && value.colorSpace === 'CMYK' && ['Lab', 'XYZ'].includes(value.connectionSpace)
    && Number.isSafeInteger(value.renderingIntent) && value.renderingIntent >= 0 && value.renderingIntent <= 3
    && positive(value.size, 4 * 1024 * 1024) && SHA256.test(value.sha256 ?? '') && positive(value.tagCount, 1_024);
}

function sourceInput(value, documentId, sourceSha256) {
  return exact(value, ['documentId', 'sha256', 'role']) && value.documentId === documentId
    && value.sha256 === sourceSha256 && value.role === 'source';
}

function validOperation(value, { type, documentId, sourceSha256, outputSha256, parameters, expected, validators, pageCount, validationExtras = {} }) {
  const validationKeys = ['passed', 'validators', 'outputSha256', 'pageCount', 'textSha256', ...Object.keys(validationExtras)];
  return exact(value, OPERATION_KEYS) && value.schemaVersion === 1 && OPAQUE_ID_PATTERN.test(value.id ?? '')
    && value.type === type && dense(value.inputs, 1, 1) && sourceInput(value.inputs[0], documentId, sourceSha256)
    && sameData(value.parameters, parameters) && sameData(value.expected, expected)
    && exact(value.validation, validationKeys)
    && value.validation.passed === true && sameData(value.validation.validators, validators)
    && value.validation.outputSha256 === outputSha256 && value.validation.pageCount === pageCount
    && SHA256.test(value.validation.textSha256 ?? '')
    && Object.entries(validationExtras).every(([key, expectedValue]) => value.validation[key] === expectedValue)
    && timestamp(value.completedAt);
}

function validArtifact(value, context) {
  return exact(value, ARTIFACT_KEYS) && OPAQUE_ID_PATTERN.test(value.id ?? '') && value.id !== context.documentId
    && value.documentId === context.documentId && typeof value.displayName === 'string' && value.displayName.length > 0
    && !value.displayName.startsWith('.') && !/[\\/\u0000]/u.test(value.displayName) && value.mediaType === 'application/pdf'
    && positive(value.size, 512 * 1024 * 1024) && value.sha256 === context.outputSha256
    && value.sha256 !== context.sourceSha256 && SHA256.test(value.sha256 ?? '') && timestamp(value.createdAt)
    && validOperation(value.operation, context);
}

function freezeSnapshot(value) {
  let copy;
  try { copy = structuredClone(value); } catch { throw new TypeError('The local host returned a hostile prepress result.'); }
  const seen = new Set();
  const freeze = (item) => {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item); for (const child of Object.values(item)) freeze(child); Object.freeze(item);
  };
  freeze(copy); return copy;
}

function validCmykResult(result, documentId) {
  if (!exact(result, ['kind', 'schemaVersion', 'sourceDigest', 'artifact', 'profile', 'recipe', 'receipt', 'authoritative', 'limitations'])
    || result.kind !== 'icc-cmyk-artifact' || result.schemaVersion !== 1 || !SHA256.test(result.sourceDigest ?? '')
    || !profile(result.profile) || result.authoritative !== false || !sameData(result.limitations, CMYK_LIMITATIONS)
    || !exact(result.recipe, ['colorConversionStrategy', 'renderingIntent', 'blackPointCompensation', 'preservesSeparationAndDeviceN', 'overrideEmbeddedIcc', 'downsampling'])
    || result.recipe.colorConversionStrategy !== 'CMYK' || result.recipe.renderingIntent !== 'relative-colorimetric'
    || result.recipe.blackPointCompensation !== true || result.recipe.preservesSeparationAndDeviceN !== true
    || result.recipe.overrideEmbeddedIcc !== false || result.recipe.downsampling !== false
    || !exact(result.receipt, ['engine', 'outputSha256', 'pageCount', 'pageGeometryPreserved', 'textExtractionEquivalent', 'everyPageRendered', 'outputIntentEmbeddedOrValidated', 'pdfXValidated'])
    || !engine(result.receipt.engine) || !SHA256.test(result.receipt.outputSha256 ?? '') || !positive(result.receipt.pageCount, 10_000)
    || result.receipt.pageGeometryPreserved !== true || result.receipt.textExtractionEquivalent !== true || result.receipt.everyPageRendered !== true
    || result.receipt.outputIntentEmbeddedOrValidated !== false || result.receipt.pdfXValidated !== false) return false;
  const parameters = { profileId: result.profile.id, profileSha256: result.profile.sha256, renderingIntent: 'relative-colorimetric', blackPointCompensation: true, preserveSeparations: true, overrideEmbeddedIcc: false };
  const expected = { pageCount: result.receipt.pageCount, outputColorSpace: 'CMYK-targeted', rasterized: false };
  return validArtifact(result.artifact, { documentId, sourceSha256: result.sourceDigest, outputSha256: result.receipt.outputSha256,
    type: 'ghostscript-icc-cmyk', parameters, expected, pageCount: result.receipt.pageCount,
    validators: ['source-sha256', 'icc-header-and-tags', 'icc-profile-sha256', 'ghostscript-exit-zero', 'poppler-page-count', 'poppler-page-boxes', 'poppler-passive-content', 'poppler-text-equivalence', 'poppler-render-all-pages', 'artifact-sha256'] });
}

function validImpositionResult(result, documentId, request) {
  if (!exact(result, ['kind', 'schemaVersion', 'sourceDigest', 'artifact', 'layout', 'receipt', 'authoritative', 'limitations'])
    || result.kind !== 'imposition-artifact' || result.schemaVersion !== 1 || !SHA256.test(result.sourceDigest ?? '')
    || result.authoritative !== false || !sameData(result.limitations, IMPOSITION_LIMITATIONS)
    || !exact(result.layout, ['id', 'across', 'down', 'order', 'sourcePageCount', 'sheetCount', 'sourcePage', 'sheet', 'marks'])
    || result.layout.id !== request.layout || request.marks !== false || ![['2x1', 2, 1], ['2x2', 2, 2]].some(([id, across, down]) => result.layout.id === id && result.layout.across === across && result.layout.down === down)
    || result.layout.order !== 'upper-left-row-major' || !positive(result.layout.sourcePageCount, 10_000) || !positive(result.layout.sheetCount, 10_000)
    || !exact(result.layout.sourcePage, ['widthPoints', 'heightPoints', 'rotation']) || !positive(result.layout.sourcePage.widthPoints, 14_400) || !positive(result.layout.sourcePage.heightPoints, 14_400) || result.layout.sourcePage.rotation !== 0
    || !exact(result.layout.sheet, ['widthPoints', 'heightPoints']) || !positive(result.layout.sheet.widthPoints, 14_400) || !positive(result.layout.sheet.heightPoints, 14_400)
    || result.layout.sheet.widthPoints !== result.layout.sourcePage.widthPoints * result.layout.across || result.layout.sheet.heightPoints !== result.layout.sourcePage.heightPoints * result.layout.down || result.layout.marks !== 'none'
    || !exact(result.receipt, ['engine', 'outputSha256', 'pageCount', 'vectorOrientedPdfwriteRewrite', 'unconditionalVectorPreservationClaim', 'textExtractionEquivalent', 'everySheetRendered', 'pdfXValidated'])
    || !engine(result.receipt.engine) || !SHA256.test(result.receipt.outputSha256 ?? '') || result.receipt.pageCount !== result.layout.sheetCount
    || result.receipt.vectorOrientedPdfwriteRewrite !== true || result.receipt.unconditionalVectorPreservationClaim !== false || result.receipt.textExtractionEquivalent !== true || result.receipt.everySheetRendered !== true || result.receipt.pdfXValidated !== false) return false;
  const parameters = { layout: result.layout.id, across: result.layout.across, down: result.layout.down, order: 'upper-left-row-major', marks: false };
  const expected = { pageCount: result.layout.sheetCount, sheetWidthPoints: result.layout.sheet.widthPoints, sheetHeightPoints: result.layout.sheet.heightPoints, rasterized: false };
  return validArtifact(result.artifact, { documentId, sourceSha256: result.sourceDigest, outputSha256: result.receipt.outputSha256, type: 'ghostscript-nup-imposition', parameters, expected, pageCount: result.layout.sheetCount,
    validators: ['source-sha256', 'uniform-source-page-geometry', 'ghostscript-exit-zero', 'poppler-page-count', 'poppler-sheet-geometry', 'poppler-passive-content', 'poppler-text-equivalence', 'poppler-render-all-pages', 'artifact-sha256'] });
}

function validOutputIntentResult(result, documentId, request) {
  if (!exact(result, ['kind', 'schemaVersion', 'sourceDigest', 'artifact', 'profile', 'proof', 'receipt', 'authoritative', 'limitations'])
    || result.kind !== 'output-intent-artifact' || result.schemaVersion !== 1 || result.sourceDigest !== request.sourceSha256
    || !profile(result.profile) || result.authoritative !== false || !dense(result.limitations, 1, 1) || result.limitations[0] !== OUTPUT_INTENT_LIMITATION
    || !exact(result.receipt, ['outputSha256', 'pageCount', 'pageGeometryPreserved', 'textExtractionEquivalent', 'everyPageRendered', 'outputIntentCount', 'pdfXValidated'])
    || !SHA256.test(result.receipt.outputSha256 ?? '') || !positive(result.receipt.pageCount, 10_000) || result.receipt.pageGeometryPreserved !== true || result.receipt.textExtractionEquivalent !== true || result.receipt.everyPageRendered !== true || result.receipt.outputIntentCount !== 1 || result.receipt.pdfXValidated !== false
    || !exact(result.proof, ['schema', 'version', 'sourceSha256', 'outputSha256', 'profileSha256', 'profileBytes', 'sourceObjectCount', 'outputObjectCount', 'objectDelta', 'xrefDelta', 'outputIntentCount', 'pageCount', 'pageTreeNodeCount', 'pagesTextBoxesRendersUnchangedExpected', 'closedClassicRevision', 'priorRevisionsAbsent', 'limitation', 'transaction', 'compactRewrite'])
    || result.proof.schema !== 'pdf-output-intent-assignment-proof-v1' || result.proof.version !== 1 || result.proof.sourceSha256 !== request.sourceSha256 || result.proof.outputSha256 !== result.receipt.outputSha256 || result.proof.profileSha256 !== result.profile.sha256 || result.proof.profileBytes !== result.profile.size
    || !positive(result.proof.sourceObjectCount, 1_000_000) || result.proof.outputObjectCount !== result.proof.sourceObjectCount + 2 || result.proof.objectDelta !== 2 || result.proof.xrefDelta !== 2 || result.proof.outputIntentCount !== 1 || result.proof.pageCount !== result.receipt.pageCount || !positive(result.proof.pageTreeNodeCount, 100_000)
    || result.proof.pagesTextBoxesRendersUnchangedExpected !== true || result.proof.closedClassicRevision !== true || result.proof.priorRevisionsAbsent !== true || result.proof.limitation !== OUTPUT_INTENT_LIMITATION
    || !exact(result.proof.transaction, ['profileObjectNumber', 'outputIntentObjectNumber', 'appendedXrefOffset']) || !positive(result.proof.transaction.profileObjectNumber, 1_000_000) || !positive(result.proof.transaction.outputIntentObjectNumber, 1_000_000) || result.proof.transaction.profileObjectNumber === result.proof.transaction.outputIntentObjectNumber || !positive(result.proof.transaction.appendedXrefOffset, 512 * 1024 * 1024)
    || !exact(result.proof.compactRewrite, ['reachableObjectCount', 'outputBytes']) || result.proof.compactRewrite.reachableObjectCount !== result.proof.outputObjectCount || !positive(result.proof.compactRewrite.outputBytes, 512 * 1024 * 1024)) return false;
  const parameters = { profileId: result.profile.id, profileSha256: result.profile.sha256, profileBytes: result.profile.size, outputIntentSubtype: 'GTS_PDFX', closedClassicRevision: true, priorRevisionsAbsent: true };
  const expected = { pageCount: result.receipt.pageCount, outputIntentCount: 1, embeddedProfileSha256: result.profile.sha256, pdfXValidated: false };
  return validArtifact(result.artifact, { documentId, sourceSha256: request.sourceSha256, outputSha256: result.receipt.outputSha256, type: 'ghostscript-cmyk-output-intent', parameters, expected, pageCount: result.receipt.pageCount,
    validationExtras: { outputIntentCount: 1, profileSha256: result.profile.sha256 },
    validators: ['source-sha256', 'icc-header-and-tags', 'icc-profile-sha256', 'output-intent-structure', 'closed-classic-rewrite', 'poppler-page-count', 'poppler-page-boxes', 'poppler-passive-content', 'poppler-text-equivalence', 'poppler-render-all-pages', 'artifact-sha256'] });
}

function checkedResult(result, validator, context) {
  if (!validator(result, ...context)) throw new TypeError('The local host returned an invalid prepress artifact result.');
  return freezeSnapshot(result);
}

function definedOptions(options) {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  );
}

function validatePreviewOptions(operation, options) {
  const keys = Object.keys(definedOptions(options));
  if (operation === 'ink-coverage' && keys.length) {
    throw new TypeError('ink-coverage does not accept page or dpi options.');
  }
  if (operation === 'preflight') {
    if (keys.some((key) => key !== 'profile')
      || (options.profile !== undefined && !PREFLIGHT_PROFILES.includes(options.profile))) {
      throw new TypeError('preflight accepts only print-review or archive-review profile.');
    }
    return;
  }
  if (operation === 'ink-coverage') return;
  if (options.page !== undefined
    && (!Number.isSafeInteger(options.page) || options.page < 1 || options.page > 10_000)) {
    throw new TypeError('page must be an integer from 1 through 10000.');
  }
  if (options.dpi !== undefined
    && (!Number.isSafeInteger(options.dpi) || options.dpi < 36 || options.dpi > 300)) {
    throw new TypeError('dpi must be an integer from 36 through 300.');
  }
}

function validOptionsObject(options, keys) {
  return plain(options) && Object.keys(options).every((key) => keys.includes(key))
    && (options.signal === undefined || options.signal instanceof AbortSignal);
}

function validOutputIntentRequest(request) {
  return Boolean(exact(request, ['profile', 'sourceSha256'])
    && request.profile === OUTPUT_INTENT_PROFILE
    && typeof request.sourceSha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(request.sourceSha256));
}

function runPrepressRequest(json, documentId, body, signal) {
  return postJson(
    json,
    documentEndpointPath(documentId, '/prepress'),
    body,
    signal,
  ).then((response) => response.result);
}

/** Prepress review, conversion, imposition, and production-validation transport. */
export function createPrepressEndpoints({ json }) {
  return {
    runPrepress(documentId, operation, { page, dpi, profile, signal } = {}) {
      if (!PREPRESS_OPERATIONS.includes(operation)) {
        throw new TypeError(
          'operation must be preflight, ink-coverage, separations, or overprint-preview.',
        );
      }
      const options = { page, dpi, profile };
      validatePreviewOptions(operation, options);
      const response = runPrepressRequest(
        json,
        documentId,
        { operation, ...definedOptions(options) },
        signal,
      );
      return operation === 'preflight'
        ? response.then((result) => validatePreflightReviewReport(result, {
          expectedProfile: profile ?? 'print-review',
        }))
        : response;
    },
    convertToCmyk(documentId, options = {}) {
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !validOptionsObject(options, ['profile', 'signal'])) {
        throw new TypeError('CMYK conversion options are invalid.');
      }
      const { profile = 'ghostscript-default-cmyk', signal } = options;
      if (profile !== 'ghostscript-default-cmyk') {
        throw new TypeError(
          'CMYK conversion requires the fixed ghostscript-default-cmyk profile.',
        );
      }
      return runPrepressRequest(
        json,
        documentId,
        { operation: 'icc-convert', profile },
        signal,
      ).then((result) => checkedResult(result, validCmykResult, [documentId]));
    },
    createImposition(documentId, options = {}) {
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !validOptionsObject(options, ['layout', 'marks', 'signal'])) {
        throw new TypeError('Imposition options are invalid.');
      }
      const { layout, marks, signal } = options;
      if (!['2x1', '2x2'].includes(layout) || typeof marks !== 'boolean') {
        throw new TypeError(
          'Imposition requires a 2x1 or 2x2 layout and boolean marks.',
        );
      }
      return runPrepressRequest(
        json,
        documentId,
        { operation: 'imposition', layout, marks },
        signal,
      ).then((result) => checkedResult(result, validImpositionResult, [documentId, { layout, marks }]));
    },
    runProductionValidation(documentId, options = {}) {
      if (!validOptionsObject(options, ['signal'])) {
        throw new TypeError('Production validation options are invalid.');
      }
      return runPrepressRequest(
        json,
        documentId,
        { operation: 'production-validation' },
        options.signal,
      );
    },
    assignOutputIntent(documentId, request, options = {}) {
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !validOutputIntentRequest(request)) {
        throw new TypeError(
          'OutputIntent assignment requires the fixed profile and current lowercase source SHA-256.',
        );
      }
      if (!validOptionsObject(options, ['signal'])) {
        throw new TypeError('OutputIntent assignment options are invalid.');
      }
      return postJson(
        json,
        documentEndpointPath(documentId, '/prepress/output-intent'),
        request,
        options.signal,
      ).then((response) => checkedResult(response?.result, validOutputIntentResult, [documentId, request]));
    },
  };
}
