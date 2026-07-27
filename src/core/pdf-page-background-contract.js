import { PlatenError } from './errors.js';
import { OPAQUE_ID_PATTERN, exactObject } from './pdfkit-client-contract-shared.js';

export const PDF_PAGE_BACKGROUND_PROFILE = 'local-classic-solid-page-background-v1';
export const PDF_PAGE_BACKGROUND_VALIDATORS = Object.freeze(['source-sha256', 'private-source-copy', 'page-background-proof', 'artifact-sha256']);
export const PDF_PAGE_BACKGROUND_LIMITATIONS = Object.freeze([
  'Only opaque solid RGB fills behind selected unrotated pages whose CropBox exactly equals MediaBox are supported.',
  'This local operation does not provide transparency, images, templates, bleed handling, or cross-viewer equivalence.',
  'The source revision remains the historical prefix; the result is an append-only incremental revision.',
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const invalid = () => { throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid source-bound page-background result.');
};
const plainArray = (value, length) => Array.isArray(value)
    && value.length === length
    && Object.getPrototypeOf(value) === Array.prototype
    && Reflect.ownKeys(value).length === length + 1
    && Array.from({ length }, (_, index) => Object.hasOwn(value, String(index))).every(Boolean)
    && Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, descriptor]) => !descriptor.get
    && !descriptor.set
    && (key === 'length' ? descriptor.enumerable === false : descriptor.enumerable === true));
const finite = (value) => typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= 1;
const box = (value) => plainArray(value, 4)
    && value.every((entry) => typeof entry === 'number'
    && Number.isFinite(entry));
const digest = (value) => typeof value === 'string'
    && SHA256.test(value);
const exact = (value, keys) => exactObject(value, keys);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const timestamp = (value) => { try { return typeof value === 'string'
    && new Date(value).toISOString() === value;
} catch { return false;
} };
function deepFreeze(value, seen = new Set()) { if (!value || typeof value !== 'object' || seen.has(value)) return value;
seen.add(value);
for (const child of Object.values(value)) deepFreeze(child, seen);
return Object.freeze(value);
}

export function validPageBackgroundRequest(value) {
  return exact(value, ['pages', 'color'])
    && plainArray(value.pages, value.pages?.length ?? -1)
    && value.pages.length >= 1
    && value.pages.length <= 500
    && value.pages.every((page, index) => Number.isSafeInteger(page)
    && page >= 1
    && page <= 500
    && (index === 0 || page > value.pages[index - 1]))
    && exact(value.color, ['r', 'g', 'b'])
    && ['r', 'g', 'b'].every((key) => finite(value.color[key])
    && Math.round(value.color[key] * 1e6) === value.color[key] * 1e6);
}
function validArtifact(artifact, context) { return exact(artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'])
    && UUID.test(artifact.id ?? '')
    && artifact.id !== context.documentId
    && artifact.documentId === context.documentId
    && artifact.displayName === 'page-background.pdf'
    && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size)
    && artifact.size >= 64
    && artifact.size <= 129 * 1024 * 1024
    && digest(artifact.sha256)
    && artifact.sha256 !== context.sourceSha256
    && timestamp(artifact.createdAt);
}
function validOperation(operation, artifact, context) { return exact(operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    && operation.schemaVersion === 1
    && UUID.test(operation.id ?? '')
    && operation.type === 'pdf-solid-page-background'
    && plainArray(operation.inputs, 1)
    && exact(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId
    && operation.inputs[0].sha256 === context.sourceSha256
    && operation.inputs[0].role === 'source'
    && exact(operation.parameters, ['profile', 'pages', 'color'])
    && operation.parameters.profile === PDF_PAGE_BACKGROUND_PROFILE
    && plainArray(operation.parameters.pages, context.request.pages.length)
    && operation.parameters.pages.every((page, index) => page === context.request.pages[index])
    && exact(operation.parameters.color, ['r', 'g', 'b'])
    && ['r', 'g', 'b'].every((key) => operation.parameters.color[key] === context.request.color[key])
    && exact(operation.expected, ['sourcePrefixPreserved', 'outputSha256'])
    && operation.expected.sourcePrefixPreserved === true
    && operation.expected.outputSha256 === artifact.sha256
    && exact(operation.validation, ['passed', 'validators', 'outputSha256'])
    && operation.validation.passed === true
    && plainArray(operation.validation.validators, PDF_PAGE_BACKGROUND_VALIDATORS.length)
    && operation.validation.validators.every((value, index) => value === PDF_PAGE_BACKGROUND_VALIDATORS[index])
    && operation.validation.outputSha256 === artifact.sha256
    && timestamp(operation.completedAt);
}
function validReference(value) { const match = typeof value === 'string'
    && value.length <= 64 ? value.match(/^(\d{1,7}) (\d{1,5}) R$/u) : null;
return Boolean(match)
    && Number(match[1]) >= 1
    && Number(match[2]) <= 65535;
}
function validPage(page, expected) { return exact(page, ['page', 'reference', 'mediaBox', 'cropBox', 'color', 'stream', 'foundationEdit'])
    && page.page === expected.page
    && validReference(page.reference)
    && box(page.mediaBox)
    && box(page.cropBox)
    && JSON.stringify(page.mediaBox) === JSON.stringify(page.cropBox)
    && exact(page.color, ['r', 'g', 'b'])
    && ['r', 'g', 'b'].every((key) => page.color[key] === expected.color[key])
    && exact(page.stream, ['reference', 'bytes', 'sha256'])
    && validReference(page.stream.reference)
    && Number.isSafeInteger(page.stream.bytes)
    && page.stream.bytes >= 1
    && digest(page.stream.sha256)
    && exact(page.foundationEdit, ['index', 'page', 'position', 'reference', 'objectNumber', 'generation', 'bytes', 'sha256', 'tokenCount', 'operatorCounts'])
    && page.foundationEdit.index >= 0
    && page.foundationEdit.page === page.page
    && page.foundationEdit.position === 'prepend'
    && page.foundationEdit.reference === page.stream.reference
    && Number.isSafeInteger(page.foundationEdit.objectNumber)
    && page.foundationEdit.objectNumber >= 1
    && page.foundationEdit.generation === 0
    && page.foundationEdit.bytes === page.stream.bytes
    && page.foundationEdit.sha256 === page.stream.sha256
    && Number.isSafeInteger(page.foundationEdit.tokenCount)
    && exact(page.foundationEdit.operatorCounts, ['f', 'q', 'Q', 're', 'rg'])
    && page.foundationEdit.operatorCounts.f === 1
    && page.foundationEdit.operatorCounts.q === 1
    && page.foundationEdit.operatorCounts.Q === 1
    && page.foundationEdit.operatorCounts.re === 1
    && page.foundationEdit.operatorCounts.rg === 1;
}
export function validatePageBackgroundResult(result, context) {
  const valid = exact(result, ['kind', 'sourceDigest', 'artifact', 'pages', 'evidence', 'limitations'])
    && result.kind === 'pdf-solid-page-background'
    && result.sourceDigest === context.sourceSha256
    && validPageBackgroundRequest(context.request)
    && plainArray(result.pages, context.request.pages.length)
    && result.pages.every((page, index) => validPage(page, { page: context.request.pages[index], color: context.request.color }))
    && validArtifact(result.artifact, context)
    && exact(result.evidence, ['sourcePrefixPreserved', 'outputDigestBound', 'sourceUnchanged', 'onlySelectedPagesChanged', 'pageBoxesUnchanged', 'resourcesUnchanged', 'annotationsUnchanged', 'localOnly'])
    && Object.values(result.evidence).every((value) => value === true)
    && plainArray(result.limitations, PDF_PAGE_BACKGROUND_LIMITATIONS.length)
    && result.limitations.every((value, index) => value === PDF_PAGE_BACKGROUND_LIMITATIONS[index])
    && validOperation(result.artifact.operation, result.artifact, context);
  if (!valid) invalid();
return deepFreeze(result);
}
