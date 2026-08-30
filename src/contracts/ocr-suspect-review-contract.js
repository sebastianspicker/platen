export const OCR_SUSPECT_REVIEW_EXPORT_PROFILE = 'local-ocr-suspect-review-export-v1';

const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REVIEW_STATES = new Set(['unreviewed', 'confirmed-low-confidence', 'false-positive']);
const MAX_SUSPECTS = 500;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

function fail(message) {
  throw new TypeError(`OCR suspect review export is invalid: ${message}`);
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))) fail(`${label} contains unsupported fields.`);
  return value;
}

function sha256(value, label) {
  if (!SHA256.test(value ?? '')) fail(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalOcrSuspectReviewJson(value) {
  return JSON.stringify(canonicalValue(value));
}

async function canonicalSha256(value) {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    fail('local Web Crypto SHA-256 support is unavailable.');
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(canonicalOcrSuspectReviewJson(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot(value) {
  try {
    return structuredClone(value);
  } catch {
    fail('input must be synchronously cloneable plain JSON data.');
  }
}

function language(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || value.includes('\0')
    || !value.split('+').every((token) => /^[a-z][a-z0-9_]{0,31}$/u.test(token))) {
    fail('OCR language is invalid.');
  }
  return value;
}

function ocrParameters(value) {
  exactObject(value, ['language', 'cleanupPreset', 'segmentation', 'pageCount', 'suspects'], 'OCR binding');
  language(value.language);
  if (!['none', 'document', 'bilevel'].includes(value.cleanupPreset)
    || !['auto', 'single-column', 'block', 'sparse'].includes(value.segmentation)
    || !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > 10_000
    || !Array.isArray(value.suspects) || value.suspects.length > MAX_SUSPECTS) fail('OCR parameters are invalid.');
  return value;
}

function suspect(value, pageCount) {
  exactObject(value, ['page', 'text', 'confidence', 'left', 'top', 'width', 'height'], 'OCR suspect');
  if (!Number.isSafeInteger(value.page) || value.page < 1 || value.page > pageCount
    || typeof value.text !== 'string' || !value.text || value.text.length > 4_096 || value.text.includes('\0')
    || !Number.isFinite(value.confidence) || value.confidence < -1 || value.confidence > 100
    || !['left', 'top', 'width', 'height'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)) {
    fail('OCR suspect is invalid.');
  }
  return value;
}

function validateBinding(value) {
  exactObject(value, ['sourceDigest', 'artifact', 'ocr', 'reviewDecisions'], 'OCR suspect review input');
  sha256(value.sourceDigest, 'sourceDigest');
  exactObject(value.artifact, ['id', 'sha256'], 'artifact binding');
  if (!OPAQUE_ID.test(value.artifact.id ?? '')) fail('artifact ID is invalid.');
  sha256(value.artifact.sha256, 'artifact SHA-256');
  const parameters = ocrParameters(value.ocr);
  const suspects = parameters.suspects.map((entry) => suspect(entry, parameters.pageCount));
  exactObject(value.reviewDecisions, Object.keys(value.reviewDecisions), 'review decisions');
  return { ...value, ocr: { ...parameters, suspects } };
}

function publicSuspect(value) {
  return {
    page: value.page, text: value.text, confidence: value.confidence,
    left: value.left, top: value.top, width: value.width, height: value.height,
  };
}

export async function ocrSuspectDigest(value) {
  const copied = snapshot(value);
  return canonicalSha256(publicSuspect(suspect(copied, 10_000)));
}

function counts(entries) {
  return {
    suspects: entries.length,
    unreviewed: entries.filter(({ reviewState }) => reviewState === 'unreviewed').length,
    confirmedLowConfidence: entries.filter(({ reviewState }) => reviewState === 'confirmed-low-confidence').length,
    falsePositive: entries.filter(({ reviewState }) => reviewState === 'false-positive').length,
  };
}

function bounded(report) {
  if (new TextEncoder().encode(canonicalOcrSuspectReviewJson(report)).byteLength > MAX_REPORT_BYTES) {
    fail('serialized report exceeds the 4 MiB limit.');
  }
  return report;
}

export async function createOcrSuspectReviewExport(input) {
  const binding = validateBinding(snapshot(input));
  const rawSuspects = binding.ocr.suspects.map(publicSuspect);
  const digests = await Promise.all(rawSuspects.map(canonicalSha256));
  if (new Set(digests).size !== digests.length) fail('duplicate OCR suspect digests are not permitted.');
  const decisionKeys = Object.keys(binding.reviewDecisions);
  if (decisionKeys.length !== digests.length || decisionKeys.some((key) => !digests.includes(key))) {
    fail('review decisions must cover exactly every deterministic suspect digest.');
  }
  const entries = rawSuspects.map((entry, index) => {
    const reviewState = binding.reviewDecisions[digests[index]];
    if (!REVIEW_STATES.has(reviewState)) fail('review decision state is invalid.');
    return { id: `ocr-suspect-${digests[index]}`, suspectSha256: digests[index], ...entry, reviewState };
  });
  const inventorySha256 = await canonicalSha256(rawSuspects);
  const report = {
    schemaVersion: 1,
    profile: OCR_SUSPECT_REVIEW_EXPORT_PROFILE,
    sourceDigest: binding.sourceDigest,
    artifact: binding.artifact,
    ocr: {
      language: binding.ocr.language, cleanupPreset: binding.ocr.cleanupPreset,
      segmentation: binding.ocr.segmentation, pageCount: binding.ocr.pageCount,
    },
    counts: counts(entries),
    inventorySha256,
    entries,
    claims: {
      correctionsApplied: false, pdfBytesChanged: false,
      ocrArtifactChanged: false, authoritativeText: false,
    },
  };
  const completed = { ...report, reportSha256: await canonicalSha256(report) };
  return deepFreeze(bounded(completed));
}

function validateReportShape(value) {
  exactObject(value, ['schemaVersion', 'profile', 'sourceDigest', 'artifact', 'ocr', 'counts', 'inventorySha256', 'entries', 'claims', 'reportSha256'], 'report');
  if (value.schemaVersion !== 1 || value.profile !== OCR_SUSPECT_REVIEW_EXPORT_PROFILE) fail('report profile is invalid.');
  sha256(value.sourceDigest, 'report sourceDigest');
  exactObject(value.artifact, ['id', 'sha256'], 'report artifact');
  if (!OPAQUE_ID.test(value.artifact.id ?? '')) fail('report artifact ID is invalid.');
  sha256(value.artifact.sha256, 'report artifact SHA-256');
  exactObject(value.ocr, ['language', 'cleanupPreset', 'segmentation', 'pageCount'], 'report OCR parameters');
  ocrParameters({ ...value.ocr, suspects: [] });
  if (!Array.isArray(value.entries) || value.entries.length > MAX_SUSPECTS) fail('report entries are invalid.');
  exactObject(value.counts, ['suspects', 'unreviewed', 'confirmedLowConfidence', 'falsePositive'], 'report counts');
  exactObject(value.claims, ['correctionsApplied', 'pdfBytesChanged', 'ocrArtifactChanged', 'authoritativeText'], 'report claims');
  if (Object.values(value.claims).some((claim) => claim !== false)) fail('report claims must all be false.');
  sha256(value.inventorySha256, 'inventory SHA-256'); sha256(value.reportSha256, 'report SHA-256');
}

export async function validateOcrSuspectReviewExport(report) {
  const checked = snapshot(report);
  validateReportShape(checked);
  const publicEntries = checked.entries.map((entry) => {
    exactObject(entry, ['id', 'suspectSha256', 'page', 'text', 'confidence', 'left', 'top', 'width', 'height', 'reviewState'], 'report entry');
    const item = publicSuspect(entry);
    suspect(item, checked.ocr.pageCount);
    if (entry.id !== `ocr-suspect-${entry.suspectSha256}` || !REVIEW_STATES.has(entry.reviewState)) fail('report entry identity or state is invalid.');
    sha256(entry.suspectSha256, 'report entry SHA-256');
    return item;
  });
  const entryDigests = await Promise.all(publicEntries.map(canonicalSha256));
  if (entryDigests.some((digest, index) => digest !== checked.entries[index].suspectSha256)
    || new Set(entryDigests).size !== entryDigests.length
    || new Set(checked.entries.map(({ id }) => id)).size !== checked.entries.length) fail('report entries are not unique or source-bound.');
  if (await canonicalSha256(publicEntries) !== checked.inventorySha256) fail('inventory digest is invalid.');
  if (canonicalOcrSuspectReviewJson(counts(checked.entries)) !== canonicalOcrSuspectReviewJson(checked.counts)) fail('report counts are invalid.');
  bounded(checked);
  const { reportSha256, ...unsigned } = checked;
  if (await canonicalSha256(unsigned) !== reportSha256) fail('report digest is invalid.');
  return deepFreeze(checked);
}
