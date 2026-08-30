const SHA256 = /^[a-f0-9]{64}$/u;
const STATUSES = Object.freeze(['pass', 'warning', 'fail', 'not-checked']);
const STATUS_SET = new Set(STATUSES);
const PROFILES = Object.freeze({
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

const ROOT_KEYS = Object.freeze([
  'kind', 'schemaVersion', 'localOnly', 'authoritative', 'profile', 'document',
  'status', 'counts', 'checks', 'limitations', 'reportSha256',
]);
const MAX_EVIDENCE_DEPTH = 8;
const MAX_EVIDENCE_ITEMS = 4_096;
const MAX_EVIDENCE_BYTES = 128 * 1024;
const MAX_REPORT_BYTES = 256 * 1024;
const PRIVATE_PATH = /(?:^|[\s"'(=])(?:\/(?:Users|private|home|tmp|var|etc)(?:\/|$)|[A-Za-z]:[\\/]|\\\\)/u;

function fail(reason) {
  throw new TypeError(`The local host returned an invalid preflight review: ${reason}`);
}

function byteLength(value) { return new TextEncoder().encode(value).byteLength; }

function xmlText(value, maximum, label) {
  if (typeof value !== 'string' || byteLength(value) > maximum || PRIVATE_PATH.test(value)) {
    fail(`${label} is invalid.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff)
      || (code >= 0xe000 && code <= 0xfffd)) continue;
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { index += 1; continue; }
    }
    fail(`${label} contains invalid text.`);
  }
  return value;
}

function descriptors(value, label) {
  if (!value || typeof value !== 'object') fail(`${label} must be JSON data.`);
  try { return Object.getOwnPropertyDescriptors(value); } catch { fail(`${label} is hostile.`); }
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object.`);
  const record = descriptors(value, label);
  const actual = Reflect.ownKeys(record);
  if (actual.length !== keys.length || actual.some((key, index) => typeof key !== 'string' || key !== keys[index])
    || actual.some((key) => !Object.hasOwn(record[key], 'value') || record[key].enumerable !== true)) {
    fail(`${label} does not have the exact schema.`);
  }
  return value;
}

function denseArray(value, minimum, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum || value.length > maximum) fail(`${label} is not a bounded array.`);
  const record = descriptors(value, label);
  const keys = Reflect.ownKeys(record);
  if (keys.length !== value.length + 1 || !Object.hasOwn(record, 'length')
    || !Object.hasOwn(record.length, 'value')
    || keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)))
    || Array.from({ length: value.length }, (_, index) => {
      const descriptor = record[String(index)];
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
    }).some((valid) => !valid)) fail(`${label} must be dense data only.`);
  return value;
}

function inspectJson(value, { depth = 0, maxDepth = 16, state, label = 'value' }) {
  state.items += 1;
  if (state.items > state.maxItems || depth > maxDepth) fail(`${label} exceeds structural bounds.`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { xmlText(value, state.maxStringBytes, label); return; }
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') fail(`${label} contains non-JSON data.`);
  if (state.active.has(value)) fail(`${label} contains a cycle.`);
  state.active.add(value);
  if (Array.isArray(value)) {
    denseArray(value, 0, state.maxItems, label);
    const record = descriptors(value, label);
    for (let index = 0; index < value.length; index += 1) {
      inspectJson(record[String(index)].value, { depth: depth + 1, maxDepth, state, label });
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must contain plain objects.`);
    const record = descriptors(value, label);
    for (const key of Reflect.ownKeys(record)) {
      const descriptor = record[key];
      if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
        || PRIVATE_PATH.test(key)) fail(`${label} contains an unsupported property.`);
      xmlText(key, 8_192, label);
      inspectJson(descriptor.value, { depth: depth + 1, maxDepth, state, label });
    }
  }
  state.active.delete(value);
}

function inspectInput(value) {
  inspectJson(value, {
    state: { active: new Set(), items: 0, maxItems: 8_192, maxStringBytes: MAX_EVIDENCE_BYTES },
    label: 'report',
  });
  let snapshot;
  try { snapshot = structuredClone(value); } catch { fail('report is hostile or not cloneable JSON data.'); }
  inspectJson(snapshot, {
    state: { active: new Set(), items: 0, maxItems: 8_192, maxStringBytes: MAX_EVIDENCE_BYTES },
    label: 'report',
  });
  return snapshot;
}

function validDigest(value) { return typeof value === 'string' && SHA256.test(value); }

function reportStatus(counts) {
  return counts.fail ? 'fail' : counts.warning || counts['not-checked'] ? 'review-required' : 'pass';
}

function validateEvidence(value) {
  inspectJson(value, {
    maxDepth: MAX_EVIDENCE_DEPTH,
    state: { active: new Set(), items: 0, maxItems: MAX_EVIDENCE_ITEMS, maxStringBytes: MAX_EVIDENCE_BYTES },
    label: 'check evidence',
  });
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('check evidence is not serializable.'); }
  if (byteLength(serialized) > MAX_EVIDENCE_BYTES) fail('check evidence exceeds its byte limit.');
}

function validateReport(value, expectedProfile) {
  exactObject(value, ROOT_KEYS, 'report');
  if (value.kind !== 'preflight-review' || value.schemaVersion !== 1
    || value.localOnly !== true || value.authoritative !== false || !validDigest(value.reportSha256)) {
    fail('report metadata is invalid.');
  }
  exactObject(value.profile, ['id', 'fixed'], 'profile');
  if (!Object.hasOwn(PROFILES, value.profile.id) || value.profile.fixed !== true
    || (expectedProfile !== undefined && value.profile.id !== expectedProfile)) fail('profile is invalid.');
  exactObject(value.document, ['sha256', 'pageCount'], 'document');
  if (!validDigest(value.document.sha256) || !Number.isSafeInteger(value.document.pageCount)
    || value.document.pageCount < 1) fail('document source binding is invalid.');
  exactObject(value.counts, STATUSES, 'counts');
  if (STATUSES.some((status) => !Number.isSafeInteger(value.counts[status]) || value.counts[status] < 0)
    || !['pass', 'review-required', 'fail'].includes(value.status)) fail('report status or counts are invalid.');
  const expectedIds = PROFILES[value.profile.id];
  denseArray(value.checks, expectedIds.length, expectedIds.length, 'checks');
  const checks = value.checks.map((check, index) => {
    exactObject(check, ['id', 'status', 'summary', 'evidence'], 'check');
    if (check.id !== expectedIds[index] || !STATUS_SET.has(check.status)
      || !/^[a-z0-9.-]{1,128}$/u.test(check.id)) fail('check identity or order is invalid.');
    xmlText(check.summary, 8_192, 'check summary');
    validateEvidence(check.evidence);
    return check;
  });
  if (STATUSES.some((status) => value.counts[status] !== checks.filter((check) => check.status === status).length)
    || value.status !== reportStatus(value.counts)) fail('report status or counts do not match checks.');
  denseArray(value.limitations, 1, 16, 'limitations');
  value.limitations.forEach((limitation) => xmlText(limitation, 8_192, 'limitation'));
}

async function exactSha256(payload) {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    fail('local Web Crypto SHA-256 support is unavailable.');
  }
  if (Object.hasOwn(Object.prototype, 'toJSON') || Object.hasOwn(Array.prototype, 'toJSON')) {
    fail('JSON serialization hooks are not permitted.');
  }
  const serialized = JSON.stringify(payload);
  if (byteLength(serialized) > MAX_REPORT_BYTES) fail('report exceeds its byte limit.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Validate and detach the fixed local preflight-review report returned to the browser. */
export async function validatePreflightReviewReport(value, { expectedProfile } = {}) {
  try {
    if (expectedProfile !== undefined && !Object.hasOwn(PROFILES, expectedProfile)) {
      throw new TypeError('preflight validation requires a supported fixed profile.');
    }
    const report = inspectInput(value);
    validateReport(report, expectedProfile);
    const { reportSha256, ...payload } = report;
    if (await exactSha256(payload) !== reportSha256) fail('report digest is invalid.');
    return deepFreeze(report);
  } catch (error) {
    if (error instanceof TypeError && /^(?:The local host returned an invalid preflight review|preflight validation requires)/u.test(error.message)) {
      throw error;
    }
    fail('report is hostile or malformed.');
  }
}
