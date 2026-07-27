import { HostError } from './host-error.mjs';

export const MAX_RASTER_PAGES = 50;
export const MAX_RASTER_DIMENSION = 2_048;
export const MAX_RASTER_WORKSPACE_BYTES = 512 * 1024 * 1024;
export const MAX_RASTER_JOB_MS = 2 * 60_000;
export const VERIFIED_RASTER_BURN_PROFILE = 'verified-raster-burn-v2';

const SHA256 = /^[0-9a-f]{64}$/;
const OPERATIONS = new Set(['rotate', 'crop', 'resize', 'overlay', 'redact', 'flatten']);

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('INVALID_PARAMETER', `${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

export function normalizedRegion(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 4
    || Object.keys(value).some((key) => !['x', 'y', 'width', 'height'].includes(key))) {
    fail('INVALID_PARAMETER', `${label} must contain exactly x, y, width, and height.`);
  }
  const values = ['x', 'y', 'width', 'height'].map((key) => value[key]);
  if (values.some((number) => !Number.isFinite(number)) || value.x < 0 || value.y < 0
    || value.width <= 0 || value.height <= 0 || value.x + value.width > 1
    || value.y + value.height > 1) {
    fail('INVALID_PARAMETER', `${label} must be a normalized rectangle inside the page.`);
  }
  return Object.freeze({ x: value.x, y: value.y, width: value.width, height: value.height });
}

function redactionTargetKind(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || Object.getPrototypeOf(entry) !== Object.prototype) {
    fail('INVALID_REDACTIONS', `Redaction ${index + 1} is invalid.`);
  }
  const keys = Object.keys(entry);
  if (keys.length === 3
    && keys.every((key) => ['page', 'removedText', 'fullPage'].includes(key))
    && entry.fullPage === true) return 'full-page';
  if (keys.length === 3
    && keys.every((key) => ['page', 'removedText', 'region'].includes(key))
    && entry.region && typeof entry.region === 'object' && !Array.isArray(entry.region)
    && Object.getPrototypeOf(entry.region) === Object.prototype
    && Object.keys(entry.region).length === 4
    && Object.keys(entry.region).every((key) => ['x', 'y', 'width', 'height'].includes(key))) {
    return 'region';
  }
  fail('INVALID_REDACTIONS', `Redaction ${index + 1} must be exactly one full-page or regional target.`);
}

export function assertRedactionTargetShapes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    fail('INVALID_REDACTIONS', 'Provide one to 64 redactions.');
  }
  value.forEach(redactionTargetKind);
}

export function assertRasterOperation(operation) {
  if (!OPERATIONS.has(operation)) fail('INVALID_OPERATION', 'Choose a supported raster mutation operation.');
  return operation;
}

export function assertVerifiedRedactionProfile(parameters, sourceSha256) {
  const allowedKeys = new Set(['operation', 'profile', 'sourceSha256', 'pages', 'redactions', 'planBinding']);
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)
    || Object.getPrototypeOf(parameters) !== Object.prototype
    || Object.keys(parameters).some((key) => !allowedKeys.has(key))
    || parameters.profile !== VERIFIED_RASTER_BURN_PROFILE
    || !SHA256.test(String(parameters.sourceSha256 ?? ''))) {
    fail('INVALID_REDACTION_PROFILE', `Redaction requires the exact ${VERIFIED_RASTER_BURN_PROFILE} source-bound profile.`);
  }
  if (parameters.sourceSha256 !== sourceSha256) {
    fail('SOURCE_VERSION_MISMATCH', 'The redaction request does not match the immutable source digest.', 409);
  }
  assertRedactionTargetShapes(parameters.redactions);
  if (parameters.planBinding !== undefined) assertPlanBinding(parameters.planBinding);
}

export function assertPlanBinding(value) {
  const keys = ['profile', 'planId', 'planSha256', 'markIds', 'workspaceRevision', 'geometryBindingSha256'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))
    || value.profile !== 'source-bound-redaction-plan-v1'
    || typeof value.planId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.planId)
    || !SHA256.test(String(value.planSha256 ?? '')) || !Array.isArray(value.markIds)
    || value.markIds.length < 1 || value.markIds.length > 64
    || new Set(value.markIds).size !== value.markIds.length
    || value.markIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
    || !Number.isSafeInteger(value.workspaceRevision) || value.workspaceRevision < 0
    || !SHA256.test(String(value.geometryBindingSha256 ?? ''))) {
    fail('INVALID_PLAN_BINDING', 'Redaction plan binding is invalid.');
  }
  return Object.freeze({ ...value, markIds: Object.freeze([...value.markIds]) });
}

export function pageSet(pages, pageCount) {
  const values = pages ?? Array.from({ length: pageCount }, (_, index) => index + 1);
  if (!Array.isArray(values) || values.length === 0 || values.length > pageCount) {
    fail('INVALID_PAGES', 'Choose one or more pages in the source document.');
  }
  return new Set(values.map((page) => boundedInteger(page, 'page', 1, pageCount)));
}

function overlay(value, page) {
  if (!value || typeof value !== 'object') fail('INVALID_PARAMETER', 'overlay is required.');
  if (!['watermark', 'header', 'footer', 'bates', 'redaction-label'].includes(value.placement)) {
    fail('INVALID_PARAMETER', 'overlay placement is invalid.');
  }
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 256
    || /[\u0000-\u001f\u007f]/.test(value.text) || value.text.startsWith('@')) {
    fail('INVALID_PARAMETER', 'overlay text must be a short printable literal.');
  }
  return Object.freeze({
    ...value,
    text: value.text.replaceAll('{page}', String(page)),
    pointSize: value.pointSize ?? 18,
  });
}

export function scaledDimensions(widthPoints, heightPoints, maxDimension = MAX_RASTER_DIMENSION) {
  const scale = maxDimension / Math.max(widthPoints, heightPoints);
  return Object.freeze({
    width: Math.max(1, Math.round(widthPoints * scale)),
    height: Math.max(1, Math.round(heightPoints * scale)),
  });
}

export function rasterRegion(region, dimensions) {
  return Object.freeze({
    x: Math.floor(region.x * dimensions.width),
    y: Math.floor(region.y * dimensions.height),
    width: Math.max(1, Math.ceil(region.width * dimensions.width)),
    height: Math.max(1, Math.ceil(region.height * dimensions.height)),
  });
}

export function insetRasterRegion(region) {
  const inset = Math.min(2, Math.floor((region.width - 1) / 2), Math.floor((region.height - 1) / 2));
  return Object.freeze({
    x: region.x + inset,
    y: region.y + inset,
    width: region.width - (2 * inset),
    height: region.height - (2 * inset),
  });
}

export function parsePageCount(output) {
  const match = String(output).match(/^Pages:\s*(\d+)\s*$/mi);
  const count = Number.parseInt(match?.[1] ?? '', 10);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RASTER_PAGES) {
    fail('INVALID_ENGINE_OUTPUT', 'The local engine did not produce a bounded PDF page count.', 502);
  }
  return count;
}

export function parsePageDimensions(output, page) {
  const expression = new RegExp(`Page\\s+${page}\\s+size:\\s*([0-9.]+)\\s+x\\s+([0-9.]+)\\s+pts`, 'i');
  const match = String(output).match(expression)
    ?? String(output).match(/Page size:\s*([0-9.]+)\s+x\s+([0-9.]+)\s+pts/i);
  const widthPoints = Number.parseFloat(match?.[1]);
  const heightPoints = Number.parseFloat(match?.[2]);
  if (!Number.isFinite(widthPoints) || !Number.isFinite(heightPoints)
    || widthPoints <= 0 || heightPoints <= 0
    || widthPoints > 14_400 || heightPoints > 14_400) {
    fail('INVALID_ENGINE_OUTPUT', `The local engine did not report valid page geometry for page ${page}.`, 502);
  }
  const rotationMatch = String(output).match(new RegExp(`Page\\s+${page}\\s+rot:\\s*(-?\\d+)`, 'i'));
  const rotation = Number.parseInt(rotationMatch?.[1] ?? '', 10);
  const mediaMatch = String(output).match(new RegExp(`Page\\s+${page}\\s+MediaBox:\\s*([+-]?[0-9.]+)\\s+([+-]?[0-9.]+)\\s+([+-]?[0-9.]+)\\s+([+-]?[0-9.]+)`, 'i'));
  const cropMatch = String(output).match(new RegExp(`Page\\s+${page}\\s+CropBox:\\s*([+-]?[0-9.]+)\\s+([+-]?[0-9.]+)\\s+([+-]?[0-9.]+)\\s+([+-]?[0-9.]+)`, 'i'));
  const media = mediaMatch?.slice(1).map(Number);
  const crop = cropMatch?.slice(1).map(Number);
  const cropWidthPoints = crop ? crop[2] - crop[0] : Number.NaN;
  const cropHeightPoints = crop ? crop[3] - crop[1] : Number.NaN;
  if (!Number.isSafeInteger(rotation) || ![0, 90, 180, 270].includes(((rotation % 360) + 360) % 360)
    || !media || media.some((coordinate) => !Number.isFinite(coordinate))
    || !crop || crop.some((coordinate) => !Number.isFinite(coordinate))
    || !Number.isFinite(cropWidthPoints) || !Number.isFinite(cropHeightPoints)
    || cropWidthPoints <= 0 || cropHeightPoints <= 0
    || cropWidthPoints > 14_400 || cropHeightPoints > 14_400) {
    fail('INVALID_ENGINE_OUTPUT', `The local engine did not report valid rotation and crop geometry for page ${page}.`, 502);
  }
  return Object.freeze({
    widthPoints,
    heightPoints,
    cropWidthPoints,
    cropHeightPoints,
    rotation: ((rotation % 360) + 360) % 360,
    cropMatchesMedia: media.every((coordinate, index) => coordinate === crop[index]),
  });
}

export function createRasterTransform(operation, parameters, page, dimensions, redactions) {
  if (operation === 'rotate') {
    const degrees = boundedInteger(parameters.degrees, 'degrees', 0, 270);
    if (![0, 90, 180, 270].includes(degrees)) {
      fail('INVALID_PARAMETER', 'degrees must be 0, 90, 180, or 270.');
    }
    return { rotateDegrees: degrees };
  }
  if (operation === 'crop') {
    return { crop: rasterRegion(normalizedRegion(parameters.region, 'region'), dimensions) };
  }
  if (operation === 'resize') {
    return {
      resize: {
        width: boundedInteger(parameters.widthPoints, 'widthPoints', 64, MAX_RASTER_DIMENSION),
        height: boundedInteger(parameters.heightPoints, 'heightPoints', 64, MAX_RASTER_DIMENSION),
      },
    };
  }
  if (operation === 'overlay') return { overlay: overlay(parameters.overlay, page) };
  if (operation === 'redact') {
    return {
      redactions: redactions
        .filter((item) => item.page === page)
        .map((item) => rasterRegion(item.region, dimensions)),
    };
  }
  return {};
}

export function validateRasterRedactions(value, selectedPages, pageCount, geometry) {
  assertRedactionTargetShapes(value);
  return value.map((entry, index) => {
    const fullPage = redactionTargetKind(entry, index) === 'full-page';
    const page = boundedInteger(entry.page, 'redaction.page', 1, pageCount);
    if (!selectedPages.has(page)) fail('INVALID_REDACTIONS', 'Each redaction page must be selected.');
    if (!geometry.has(page)) fail('INVALID_REDACTIONS', 'Redaction page geometry is unavailable.');
    if (geometry.get(page).rotation !== 0) {
      fail('REDACTION_PAGE_ROTATION_UNSUPPORTED', 'Verified raster redaction currently requires an unrotated source page.', 422);
    }
    if (!geometry.get(page).cropMatchesMedia) {
      fail('REDACTION_PAGE_CROP_UNSUPPORTED', 'Verified raster redaction currently requires matching MediaBox and CropBox geometry.', 422);
    }
    if (typeof entry.removedText !== 'string' || !entry.removedText.trim()
      || entry.removedText.length > 256) {
      fail('INVALID_REDACTIONS', 'Every redaction must declare the source text it removes.');
    }
    const region = fullPage
      ? Object.freeze({ x: 0, y: 0, width: 1, height: 1 })
      : normalizedRegion(entry.region, 'redaction.region');
    const validationRegion = rasterRegion(region, geometry.get(page).validation);
    if (validationRegion.width < 3 || validationRegion.height < 3) {
      fail('REDACTION_REGION_TOO_SMALL', 'A redaction region must cover at least three validation pixels in each dimension.', 422);
    }
    return Object.freeze({ page, region, removedText: entry.removedText, fullPage });
  });
}

export function publicRasterParameters(operation, parameters, validatedRedactions = []) {
  const output = {
    operation,
    rasterizationDisclosure: 'Rasterization destroys vectors, forms, links, tags, and signatures.',
  };
  if (parameters.pages) output.pages = [...parameters.pages];
  if (operation === 'rotate') output.degrees = parameters.degrees;
  if (operation === 'crop') output.region = normalizedRegion(parameters.region, 'region');
  if (operation === 'resize') {
    output.widthPoints = parameters.widthPoints;
    output.heightPoints = parameters.heightPoints;
  }
  if (operation === 'overlay') {
    output.overlay = {
      ...parameters.overlay,
      text: parameters.overlay?.text?.replaceAll('{page}', '{page}'),
    };
  }
  if (operation === 'redact') {
    output.profile = VERIFIED_RASTER_BURN_PROFILE;
    output.redactions = validatedRedactions.map(({ page, region, fullPage }) => ({
      page,
      ...(fullPage ? { fullPage: true } : { region }),
    }));
    output.textEvidence = 'validated-transiently-not-retained';
    if (parameters.planBinding) output.planBinding = assertPlanBinding(parameters.planBinding);
  }
  return output;
}
