import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { HostError } from './host-error.mjs';

export const PREFLIGHT_PROFILES = Object.freeze(['print-review', 'archive-review']);

const PROFILE_SET = new Set(PREFLIGHT_PROFILES);
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RESOURCE_RECORDS = 10_000;
const PREFLIGHT_STATUSES = Object.freeze(['pass', 'warning', 'fail', 'not-checked']);
const PREFLIGHT_STATUS_SET = new Set(PREFLIGHT_STATUSES);
const MAX_XML_EVIDENCE_DEPTH = 8;
const MAX_XML_EVIDENCE_ITEMS = 4_096;
const MAX_XML_EVIDENCE_BYTES = 128 * 1_024;
const PREFLIGHT_CHECK_IDS = Object.freeze({
  'print-review': Object.freeze([
    'document.encryption', 'document.javascript', 'fonts.embedding',
    'pages.geometry-consistency', 'pages.production-boxes', 'pages.inspection-range',
    'images.inventory', 'images.effective-resolution', 'color.output-intent',
    'color.spot-and-overprint-semantics',
  ]),
  'archive-review': Object.freeze([
    'document.encryption', 'document.javascript', 'fonts.embedding',
    'pages.geometry-consistency', 'pages.inspection-range', 'metadata.xmp',
    'color.output-intent',
  ]),
});

function fail(code, message, status = 400) { throw new HostError(code, message, status); }
function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function result(id, status, summary, evidence = {}) {
  return frozen({ id, status, summary, evidence });
}
function yes(value) { return String(value ?? '').trim().toLowerCase() === 'yes'; }
function no(value) { return String(value ?? '').trim().toLowerCase() === 'no'; }
function boxContains(outer, inner) {
  return outer && inner && outer.left <= inner.left && outer.bottom <= inner.bottom
    && outer.right >= inner.right && outer.top >= inner.top;
}
function assertStableJsonPrototypes() {
  if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    || Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) {
    fail('INVALID_PREFLIGHT_REPORT', 'Preflight report hashing rejects inherited JSON hooks.');
  }
}
function deterministicDigest(value) {
  assertStableJsonPrototypes();
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function exactDataObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML requires a valid report object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML requires a valid report object.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some((key) => typeof key !== 'string')
    || actual.length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key)
      || !('value' in descriptors[key]) || descriptors[key].enumerable !== true)) {
    fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML requires the exact report schema.');
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function exactArray(value, maximum) {
  if (!Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum) {
    fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML report arrays exceed their schema bounds.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
  const actualKeys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
  if (actualKeys.some((key) => typeof key !== 'string')
    || actualKeys.length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(descriptors, key)
      || !('value' in descriptors[key]) || descriptors[key].enumerable !== true)) {
    fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML requires dense data-only arrays.');
  }
  return expectedKeys.map((key) => descriptors[key].value);
}

function validXmlString(value, maximumBytes) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximumBytes) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    const valid = codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!valid) return false;
  }
  return true;
}

function xmlEscape(value, maximumBytes = 8_192) {
  if (!validXmlString(value, maximumBytes)) {
    fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML contains invalid or oversized text.');
  }
  return value.replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function canonicalEvidenceJson(value) {
  let items = 0;
  const active = new Set();
  function visit(current, depth) {
    items += 1;
    if (items > MAX_XML_EVIDENCE_ITEMS || depth > MAX_XML_EVIDENCE_DEPTH) {
      fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML evidence exceeds its structural bounds.');
    }
    if (current === null || typeof current === 'boolean') return JSON.stringify(current);
    if (typeof current === 'string') {
      if (Buffer.byteLength(current) > MAX_XML_EVIDENCE_BYTES) {
        fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML evidence contains oversized text.');
      }
      return JSON.stringify(current);
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML evidence contains an invalid number.');
      return JSON.stringify(current);
    }
    if (!current || typeof current !== 'object' || isProxy(current) || active.has(current)) {
      fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML evidence must be acyclic JSON data.');
    }
    active.add(current);
    let serialized;
    if (Array.isArray(current)) {
      serialized = `[${exactArray(current, MAX_XML_EVIDENCE_ITEMS).map((item) => visit(item, depth + 1)).join(',')}]`;
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML evidence must contain plain JSON objects.');
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== 'string')
        || keys.some((key) => !('value' in descriptors[key])
          || descriptors[key].enumerable !== true
          || Buffer.byteLength(key) > 8_192)) {
        fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML evidence must contain data properties only.');
      }
      keys.sort();
      serialized = `{${keys.map((key) => `${JSON.stringify(key)}:${visit(descriptors[key].value, depth + 1)}`).join(',')}}`;
    }
    active.delete(current);
    return serialized;
  }
  const serialized = visit(value, 0);
  if (Buffer.byteLength(serialized) > MAX_XML_EVIDENCE_BYTES) {
    fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML evidence exceeds its byte limit.');
  }
  return serialized;
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !PROFILE_SET.has(input.profile)) fail('INVALID_PREFLIGHT_PROFILE', 'Choose a supported fixed local preflight profile.');
  if (!input.document || typeof input.document !== 'object' || !SHA256.test(input.document.sha256 ?? '')) fail('INVALID_PREFLIGHT_INPUT', 'Preflight requires an immutable source digest.');
  if (!input.inspection || !Number.isSafeInteger(input.inspection.pageCount) || input.inspection.pageCount < 1) fail('INVALID_PREFLIGHT_INPUT', 'Preflight requires valid document inspection evidence.');
  if (!input.structure || !Array.isArray(input.structure.pageBoxes) || !input.structure.pageRange) fail('INVALID_PREFLIGHT_INPUT', 'Preflight requires bounded page-box evidence.');
  if (!Array.isArray(input.fonts) || !Array.isArray(input.images) || input.fonts.length > MAX_RESOURCE_RECORDS || input.images.length > MAX_RESOURCE_RECORDS) fail('PREFLIGHT_RESOURCE_LIMIT', 'Preflight resource inventory exceeds the local report limit.', 413);
  if (input.structure.sourceDigest !== input.document.sha256
    || input.fonts.some((font) => font?.sourceSha256 !== input.document.sha256)
    || input.images.some((image) => image?.sourceSha256 !== input.document.sha256)) {
    fail('INVALID_PREFLIGHT_INPUT', 'Preflight structure and resource evidence must match the immutable source digest.');
  }
}

function commonChecks({ inspection, fonts }) {
  const checks = [];
  const encryption = no(inspection.encrypted)
    ? result('document.encryption', 'pass', 'The PDF is not encrypted.', { encrypted: false })
    : yes(inspection.encrypted)
      ? result('document.encryption', 'warning', 'The PDF is encrypted and may not be accepted by downstream production workflows.', { encrypted: true })
      : result('document.encryption', 'not-checked', 'Encryption state could not be determined.', { reported: String(inspection.encrypted ?? 'unknown').slice(0, 80) });
  checks.push(encryption);
  checks.push(no(inspection.javascript)
    ? result('document.javascript', 'pass', 'No document JavaScript was reported.', { javascript: false })
    : yes(inspection.javascript)
      ? result('document.javascript', 'fail', 'Document JavaScript was reported.', { javascript: true })
      : result('document.javascript', 'not-checked', 'Document JavaScript state could not be determined.'));

  const unembedded = fonts.filter((font) => !yes(font.embedded));
  checks.push(unembedded.length
    ? result('fonts.embedding', 'fail', `${unembedded.length} font resource${unembedded.length === 1 ? ' is' : 's are'} not reported as embedded.`, {
      fontCount: fonts.length, unembeddedCount: unembedded.length,
      examples: unembedded.slice(0, 20).map(({ name }) => String(name ?? 'Unknown').slice(0, 120)),
    })
    : result('fonts.embedding', 'pass', fonts.length ? 'Every reported font resource is embedded.' : 'No font resources were reported.', { fontCount: fonts.length }));
  return checks;
}

function imageChecks(images, profile) {
  if (profile !== 'print-review') return [];
  const invalid = images.filter((image) => !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
    || image.width < 1 || image.height < 1 || !Number.isSafeInteger(image.bitsPerComponent) || image.bitsPerComponent < 1);
  const lowResolution = images.filter((image) => Number.isFinite(image.xPpi) && Number.isFinite(image.yPpi)
    && Math.min(image.xPpi, image.yPpi) < 150);
  const unknownResolution = images.filter((image) => !Number.isFinite(image.xPpi) || !Number.isFinite(image.yPpi));
  return [
    invalid.length
      ? result('images.inventory', 'fail', `${invalid.length} image resource${invalid.length === 1 ? ' has' : 's have'} invalid geometry or component depth.`, { imageCount: images.length, invalidCount: invalid.length })
      : result('images.inventory', 'pass', `${images.length} image resource${images.length === 1 ? '' : 's'} inspected for geometry, color label, component depth, and encoding.`, { imageCount: images.length }),
    lowResolution.length
      ? result('images.effective-resolution', 'warning', `${lowResolution.length} image resource${lowResolution.length === 1 ? ' is' : 's are'} below the fixed 150 PPI review threshold.`, { lowResolutionCount: lowResolution.length, minimumReviewPpi: 150 })
      : unknownResolution.length
        ? result('images.effective-resolution', 'not-checked', `${unknownResolution.length} image resource${unknownResolution.length === 1 ? ' has' : 's have'} no usable effective-resolution evidence.`, { unknownResolutionCount: unknownResolution.length, minimumReviewPpi: 150 })
        : result('images.effective-resolution', 'pass', images.length ? 'Every reported image is at least 150 PPI.' : 'No raster image resources were reported.', { minimumReviewPpi: 150 }),
  ];
}

function pageChecks(structure, profile) {
  const boxes = structure.pageBoxes;
  const incomplete = Boolean(structure.pageRange.truncated);
  const sizes = new Set(boxes.map(({ widthPoints, heightPoints }) => `${widthPoints}x${heightPoints}`));
  const invalidContainment = boxes.filter(({ boxes: pageBoxes }) => (pageBoxes.bleedBox && !boxContains(pageBoxes.mediaBox, pageBoxes.bleedBox))
    || (pageBoxes.trimBox && pageBoxes.bleedBox && !boxContains(pageBoxes.bleedBox, pageBoxes.trimBox)));
  const missingProductionBoxes = boxes.filter(({ boxes: pageBoxes }) => !pageBoxes.trimBox || !pageBoxes.bleedBox);
  const checks = [sizes.size > 1
    ? result('pages.geometry-consistency', 'warning', `${sizes.size} page geometries occur in the inspected range.`, { distinctGeometryCount: sizes.size, inspectedPages: boxes.length })
    : result('pages.geometry-consistency', 'pass', 'The inspected pages use one page geometry.', { inspectedPages: boxes.length })];
  if (profile === 'print-review') {
    checks.push(invalidContainment.length
      ? result('pages.production-boxes', 'fail', `${invalidContainment.length} page${invalidContainment.length === 1 ? ' has' : 's have'} invalid MediaBox, BleedBox, or TrimBox containment.`, { invalidPageCount: invalidContainment.length })
      : missingProductionBoxes.length
        ? result('pages.production-boxes', 'warning', `${missingProductionBoxes.length} inspected page${missingProductionBoxes.length === 1 ? ' lacks' : 's lack'} a TrimBox or BleedBox.`, { missingPageCount: missingProductionBoxes.length })
        : result('pages.production-boxes', 'pass', 'Every inspected page has nested MediaBox, BleedBox, and TrimBox geometry.', { inspectedPages: boxes.length }));
  }
  if (incomplete) checks.push(result('pages.inspection-range', 'not-checked', 'The page-box review was capped before the final document page.', {
    inspectedFirstPage: structure.pageRange.firstPage,
    inspectedLastPage: structure.pageRange.lastPage,
  }));
  else checks.push(result('pages.inspection-range', 'pass', 'The page-box review covers every page.', { inspectedPages: boxes.length }));
  return checks;
}

/** Fixed, non-certifying rules over bounded Poppler evidence. */
export function buildPreflightReport(input) {
  validateInput(input);
  const { profile, document, inspection, structure, fonts, images } = input;
  const checks = [...commonChecks({ inspection, fonts }), ...pageChecks(structure, profile), ...imageChecks(images, profile)];
  if (profile === 'archive-review') {
    const xmpPresent = structure.xmpMetadata?.present === true;
    checks.push(xmpPresent
      ? result('metadata.xmp', 'pass', 'An XMP metadata packet is present.', { present: true })
      : result('metadata.xmp', 'fail', 'No XMP metadata packet was reported.', { present: false }));
    if (yes(inspection.encrypted)) checks[0] = result('document.encryption', 'fail', 'The archive-review profile rejects encrypted PDFs.', { encrypted: true });
  }
  checks.push(result('color.output-intent', 'not-checked', 'Output-intent and ICC profile semantics require an ICC-aware PDF engine.'));
  if (profile === 'print-review') checks.push(result('color.spot-and-overprint-semantics', 'not-checked', 'Spot-color aliases, trapping, and object-level overprint semantics are not certified by this report.'));

  const counts = Object.freeze(Object.fromEntries(PREFLIGHT_STATUSES.map((checkStatus) => [checkStatus, checks.filter((check) => check.status === checkStatus).length])));
  const status = counts.fail ? 'fail' : counts.warning || counts['not-checked'] ? 'review-required' : 'pass';
  const payload = {
    kind: 'preflight-review', schemaVersion: 1, localOnly: true, authoritative: false,
    profile: Object.freeze({ id: profile, fixed: true }),
    document: Object.freeze({ sha256: document.sha256, pageCount: inspection.pageCount }),
    status, counts, checks: Object.freeze(checks),
    limitations: Object.freeze([
      'This is a deterministic local review profile, not PDF/A, PDF/X, PDF/UA, GWG, Ghent, or Certified PDF validation.',
      'No fixups are applied and no production acceptance certificate is issued.',
    ]),
  };
  return frozen({ ...payload, reportSha256: deterministicDigest(payload) });
}

function validatedXmlReport(report) {
  assertStableJsonPrototypes();
  const value = exactDataObject(report, [
    'kind', 'schemaVersion', 'localOnly', 'authoritative', 'profile', 'document',
    'status', 'counts', 'checks', 'limitations', 'reportSha256',
  ]);
  if (value.kind !== 'preflight-review' || value.schemaVersion !== 1
    || value.localOnly !== true || value.authoritative !== false
    || !SHA256.test(value.reportSha256 ?? '')) {
    fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML requires a local, non-authoritative schema-v1 report.');
  }
  const profile = exactDataObject(value.profile, ['id', 'fixed']);
  const document = exactDataObject(value.document, ['sha256', 'pageCount']);
  const counts = exactDataObject(value.counts, PREFLIGHT_STATUSES);
  if (!PROFILE_SET.has(profile.id) || profile.fixed !== true
    || !SHA256.test(document.sha256 ?? '')
    || !Number.isSafeInteger(document.pageCount) || document.pageCount < 1
    || !['pass', 'review-required', 'fail'].includes(value.status)
    || PREFLIGHT_STATUSES.some((checkStatus) => !Number.isSafeInteger(counts[checkStatus]) || counts[checkStatus] < 0)) {
    fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML report metadata is invalid.');
  }
  const checks = exactArray(value.checks, 32).map((rawCheck) => {
    const check = exactDataObject(rawCheck, ['id', 'status', 'summary', 'evidence']);
    if (!/^[a-z0-9.-]{1,128}$/u.test(check.id ?? '')
      || !PREFLIGHT_STATUS_SET.has(check.status)
      || !validXmlString(check.summary, 8_192)) {
      fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML contains an invalid check.');
    }
    return { ...check, evidenceJson: canonicalEvidenceJson(check.evidence) };
  });
  const expectedCheckIds = PREFLIGHT_CHECK_IDS[profile.id];
  if (checks.length !== expectedCheckIds.length
    || checks.some((check, index) => check.id !== expectedCheckIds[index])
    || PREFLIGHT_STATUSES.some((checkStatus) => counts[checkStatus] !== checks.filter((check) => check.status === checkStatus).length)
    || value.status !== (counts.fail ? 'fail' : counts.warning || counts['not-checked'] ? 'review-required' : 'pass')) {
    fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML report counts or status do not match its checks.');
  }
  const limitations = exactArray(value.limitations, 16);
  if (limitations.length < 1 || limitations.some((limitation) => !validXmlString(limitation, 8_192))) {
    fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML limitations are invalid.');
  }
  const payload = {
    kind: value.kind, schemaVersion: value.schemaVersion, localOnly: value.localOnly,
    authoritative: value.authoritative, profile: value.profile, document: value.document,
    status: value.status, counts: value.counts, checks: value.checks,
    limitations: value.limitations,
  };
  if (deterministicDigest(payload) !== value.reportSha256) {
    fail('INVALID_PREFLIGHT_REPORT', 'Preflight XML report integrity verification failed.');
  }
  return { ...value, profile, document, counts, checks, limitations };
}

/** Deterministic, escaped XML projection of one validated preflight report. */
export function serializePreflightReportXml(report) {
  const value = validatedXmlReport(report);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<preflight-review schema-version="1" local-only="true" authoritative="false" report-sha256="${value.reportSha256}">`,
    `  <profile id="${xmlEscape(value.profile.id)}" fixed="true"/>`,
    `  <document sha256="${value.document.sha256}" page-count="${value.document.pageCount}"/>`,
    `  <result status="${value.status}">`,
    `    <counts pass="${value.counts.pass}" warning="${value.counts.warning}" fail="${value.counts.fail}" not-checked="${value.counts['not-checked']}"/>`,
    '  </result>',
    `  <checks count="${value.checks.length}">`,
  ];
  for (const check of value.checks) {
    lines.push(
      `    <check id="${xmlEscape(check.id)}" status="${check.status}">`,
      `      <summary>${xmlEscape(check.summary)}</summary>`,
      `      <evidence encoding="canonical-json">${xmlEscape(check.evidenceJson, MAX_XML_EVIDENCE_BYTES * 6)}</evidence>`,
      '    </check>',
    );
  }
  lines.push('  </checks>', `  <limitations count="${value.limitations.length}">`);
  for (const limitation of value.limitations) {
    lines.push(`    <limitation>${xmlEscape(limitation)}</limitation>`);
  }
  lines.push('  </limitations>', '</preflight-review>');
  return `${lines.join('\n')}\n`;
}
