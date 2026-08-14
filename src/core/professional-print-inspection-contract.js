const SHA256 = /^[0-9a-f]{64}$/u;
const REQUEST_KEYS = Object.freeze(['capabilityId', 'sourceSha256']);
const FONT_CAPABILITY = 'print.font-inspection-embedding';
const IMAGE_CAPABILITY = 'print.image-resolution-compression';

export const PROFESSIONAL_PRINT_INSPECTION_CAPABILITIES = Object.freeze([FONT_CAPABILITY, IMAGE_CAPABILITY]);
export const PROFESSIONAL_PRINT_INSPECTION_LIMITATIONS = Object.freeze({
  [FONT_CAPABILITY]: Object.freeze(['Embedding and subsetting are reported from local inspection evidence; no press certification or outline conversion is performed.']),
  [IMAGE_CAPABILITY]: Object.freeze(['Resolution is a bounded review threshold; no recompression or press suitability claim is made.']),
});

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_LOCAL_HOST';
  throw error;
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value')
      && descriptors[key].enumerable === true && descriptors[key].configurable === true && descriptors[key].writable === true);
}

function dense(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[index];
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true
      && descriptor.configurable === true && descriptor.writable === true;
  }).every(Boolean);
}

function safeInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function text(value, maximum = 256) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum
    && value === value.normalize('NFC') && value.trim() === value
    && !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value);
}

function inspectData(value, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 2_000) invalid('Inspection data contains too many values.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    state.stringUnits += value.length;
    if (state.stringUnits > 100_000) invalid('Inspection data contains too much text.');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('Inspection data contains a non-finite number.');
    return;
  }
  if (!value || typeof value !== 'object' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    invalid('Inspection data must contain JSON-compatible values only.');
  }
  if (depth > 8 || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) invalid('Inspection data contains an unsupported binary value.');
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    invalid('Inspection data contains a hostile object.');
  }
  if ((Array.isArray(value) && prototype !== Array.prototype) || (!Array.isArray(value) && prototype !== Object.prototype)) {
    invalid('Inspection data must use ordinary objects and arrays.');
  }
  if (state.active.has(value)) invalid('Inspection data must not contain cycles.');
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => key !== 'length' && (typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true))) {
    invalid('Inspection data must contain enumerable data properties only.');
  }
  state.active.add(value);
  if (Array.isArray(value)) {
    const expected = Array.from({ length: value.length }, (_, index) => String(index));
    if (!Number.isSafeInteger(value.length) || keys.length !== expected.length + 1 || keys.some((key) => key !== 'length' && !expected.includes(key))) {
      invalid('Inspection arrays must be dense.');
    }
    for (const key of expected) inspectData(descriptors[key].value, state, depth + 1);
  } else {
    for (const key of keys) inspectData(descriptors[key].value, state, depth + 1);
  }
  state.active.delete(value);
}

function snapshot(value) {
  inspectData(value, { active: new Set(), nodes: 0, stringUnits: 0 });
  try {
    return structuredClone(value);
  } catch {
    invalid('Inspection data cannot be structured-cloned.');
  }
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function limitations(value, capabilityId) {
  const expected = PROFESSIONAL_PRINT_INSPECTION_LIMITATIONS[capabilityId];
  return dense(value, 1) && value.length === 1 && value[0] === expected[0];
}

function validFont(record, sourceSha256) {
  return exact(record, ['name', 'type', 'encoding', 'embedded', 'subset', 'unicode', 'sourceSha256'])
    && text(record.name) && text(record.type) && text(record.encoding) && text(record.embedded, 32)
    && text(record.subset, 32) && text(record.unicode, 32) && record.sourceSha256 === sourceSha256;
}

function fontMissing(record) {
  return record.embedded.toLowerCase() !== 'yes';
}

function validImage(record, sourceSha256) {
  const ppi = (value) => value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100_000);
  return exact(record, ['page', 'number', 'type', 'width', 'height', 'color', 'bitsPerComponent', 'encoding', 'objectId', 'generation', 'xPpi', 'yPpi', 'sourceSha256'])
    && safeInteger(record.page, 1, 1_000_000) && safeInteger(record.number, 0, 1_000_000)
    && text(record.type, 128) && safeInteger(record.width, 1, 1_000_000) && safeInteger(record.height, 1, 1_000_000)
    && text(record.color, 128) && safeInteger(record.bitsPerComponent, 1, 64) && text(record.encoding, 128)
    && safeInteger(record.objectId, 1, 1_000_000) && safeInteger(record.generation, 0, 65_535)
    && ppi(record.xPpi) && ppi(record.yPpi) && record.sourceSha256 === sourceSha256;
}

function imageResolution(record) {
  const known = record.xPpi !== null && record.yPpi !== null;
  return { known, below: known && Math.min(record.xPpi, record.yPpi) < 150 };
}

export function normalizeProfessionalPrintInspectionRequest(value, capabilityId = null) {
  const request = snapshot(value);
  if (capabilityId !== null) {
    if (!PROFESSIONAL_PRINT_INSPECTION_CAPABILITIES.includes(capabilityId) || !exact(request, ['sourceSha256']) || !SHA256.test(request.sourceSha256 ?? '')) {
      invalid('Professional print inspection request is invalid.');
    }
    return freeze({ capabilityId, sourceSha256: request.sourceSha256 });
  }
  if (!exact(request, REQUEST_KEYS) || !PROFESSIONAL_PRINT_INSPECTION_CAPABILITIES.includes(request.capabilityId)
    || !SHA256.test(request.sourceSha256 ?? '')) invalid('Professional print inspection request is invalid.');
  return freeze({ capabilityId: request.capabilityId, sourceSha256: request.sourceSha256 });
}

export function validateProfessionalPrintInspectionResult(value, request) {
  const normalizedRequest = normalizeProfessionalPrintInspectionRequest(request);
  const result = snapshot(value);
  const common = ['kind', 'schemaVersion', 'capabilityId', 'ok', 'localOnly', 'sourceSha256', 'inspected', 'authoritative', 'certified', 'limitations'];
  const isFont = normalizedRequest.capabilityId === FONT_CAPABILITY;
  const keys = isFont
    ? [...common, 'method', 'fonts', 'fontCount', 'returnedFontCount', 'truncated', 'missingEmbedCount']
    : [...common, 'method', 'images', 'imageCount', 'returnedImageCount', 'truncated', 'dpiThreshold', 'belowThreshold', 'belowThresholdCount', 'unknownResolutionCount', 'compressionControlled'];
  if (!exact(result, keys) || result.kind !== 'professional-capability-result' || result.schemaVersion !== 1
    || result.capabilityId !== normalizedRequest.capabilityId || result.ok !== true || result.localOnly !== true
    || result.sourceSha256 !== normalizedRequest.sourceSha256 || result.inspected !== true || result.authoritative !== false
    || result.certified !== false || !limitations(result.limitations, normalizedRequest.capabilityId)) {
    invalid('Professional print inspection result is invalid.');
  }
  if (isFont) {
    if (result.method !== 'validated-local-font-inventory' || !dense(result.fonts, 100)
      || !safeInteger(result.fontCount, 0, 100_000) || result.returnedFontCount !== result.fonts.length
      || result.fontCount < result.returnedFontCount
      || result.truncated !== (result.fontCount > result.returnedFontCount)
      || !safeInteger(result.missingEmbedCount, 0, result.fontCount)
      || result.fonts.some((record) => !validFont(record, normalizedRequest.sourceSha256))) invalid('Professional font inspection result is invalid.');
    const returnedMissing = result.fonts.filter(fontMissing).length;
    if (result.missingEmbedCount < returnedMissing
      || (!result.truncated && result.missingEmbedCount !== returnedMissing)) {
      invalid('Professional font inspection counts are invalid.');
    }
  } else if (result.method !== 'validated-local-image-inventory' || !dense(result.images, 100)
    || !safeInteger(result.imageCount, 0, 100_000) || result.returnedImageCount !== result.images.length
    || result.imageCount < result.returnedImageCount
    || result.truncated !== (result.imageCount > result.returnedImageCount) || result.dpiThreshold !== 150
    || typeof result.belowThreshold !== 'boolean' || !safeInteger(result.belowThresholdCount, 0, result.imageCount)
    || !safeInteger(result.unknownResolutionCount, 0, result.imageCount)
    || result.belowThreshold !== (result.belowThresholdCount > 0)
    || result.belowThresholdCount + result.unknownResolutionCount > result.imageCount || result.compressionControlled !== false
    || result.images.some((record) => !validImage(record, normalizedRequest.sourceSha256))) {
    invalid('Professional image inspection result is invalid.');
  } else {
    const resolutions = result.images.map(imageResolution);
    const returnedBelow = resolutions.filter(({ below }) => below).length;
    const returnedUnknown = resolutions.filter(({ known }) => !known).length;
    if (result.belowThresholdCount < returnedBelow || result.unknownResolutionCount < returnedUnknown
      || (!result.truncated && (result.belowThresholdCount !== returnedBelow
        || result.unknownResolutionCount !== returnedUnknown))) {
      invalid('Professional image inspection counts are invalid.');
    }
  }
  return freeze(result);
}

export function validateProfessionalPrintInspectionResponse(value, request) {
  const response = snapshot(value);
  if (!exact(response, ['result'])) invalid('Professional print inspection response is invalid.');
  return validateProfessionalPrintInspectionResult(response.result, request);
}
