import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  buildPreflightReport,
  serializePreflightReportXml,
} from '../scripts/host/preflight-rules.mjs';

function evidence(overrides = {}) {
  return {
    profile: 'print-review',
    document: { sha256: 'a'.repeat(64) },
    inspection: { pageCount: 1, encrypted: 'no', javascript: 'no', pdfVersion: '1.7' },
    structure: {
      pageRange: { firstPage: 1, lastPage: 1, truncated: false },
      pageBoxes: [{
        page: 1, widthPoints: 612, heightPoints: 792,
        boxes: {
          mediaBox: { left: 0, bottom: 0, right: 612, top: 792 },
          bleedBox: { left: 9, bottom: 9, right: 603, top: 783 },
          trimBox: { left: 18, bottom: 18, right: 594, top: 774 },
        },
      }],
      xmpMetadata: { present: true },
    },
    fonts: [{ name: 'Embedded', embedded: 'yes', unicode: 'yes' }],
    images: [{ width: 600, height: 400, color: 'rgb', bitsPerComponent: 8, encoding: 'jpeg', xPpi: 300, yPpi: 300 }],
    ...overrides,
  };
}

function rehashReport(report, overrides) {
  const { reportSha256: _oldDigest, ...originalPayload } = report;
  const payload = { ...originalPayload, ...overrides };
  const reportSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { ...payload, reportSha256 };
}

test('fixed preflight rules produce deterministic bounded non-certifying reports', () => {
  const first = buildPreflightReport(evidence());
  const second = buildPreflightReport(evidence());
  assert.deepEqual(first, second);
  assert.equal(first.kind, 'preflight-review');
  assert.equal(first.authoritative, false);
  assert.match(first.reportSha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.checks.find(({ id }) => id === 'fonts.embedding').status, 'pass');
  assert.equal(first.checks.find(({ id }) => id === 'images.effective-resolution').status, 'pass');
  assert.equal(first.status, 'review-required');
  assert.equal(Object.isFrozen(first.checks), true);
  assert.match(first.limitations[0], /not PDF\/A, PDF\/X, PDF\/UA/);
});

test('preflight fails known defects and keeps unavailable semantics explicitly unchecked', () => {
  const report = buildPreflightReport(evidence({
    profile: 'archive-review',
    inspection: { pageCount: 2, encrypted: 'yes', javascript: 'yes' },
    fonts: [{ name: 'Missing', embedded: 'no', unicode: 'no' }],
    images: [],
    structure: {
      pageRange: { firstPage: 1, lastPage: 1, truncated: true },
      pageBoxes: [{ page: 1, widthPoints: 612, heightPoints: 792, boxes: { mediaBox: { left: 0, bottom: 0, right: 612, top: 792 } } }],
      xmpMetadata: { present: false },
    },
  }));
  assert.equal(report.status, 'fail');
  for (const id of ['document.encryption', 'document.javascript', 'fonts.embedding', 'metadata.xmp']) {
    assert.equal(report.checks.find((check) => check.id === id).status, 'fail');
  }
  assert.equal(report.checks.find(({ id }) => id === 'color.output-intent').status, 'not-checked');
  assert.equal(report.checks.find(({ id }) => id === 'pages.inspection-range').status, 'not-checked');
});

test('preflight rejects arbitrary profiles and unbounded resource inventories', () => {
  assert.throws(() => buildPreflightReport(evidence({ profile: 'PDF/X-4' })), { code: 'INVALID_PREFLIGHT_PROFILE' });
  assert.throws(() => buildPreflightReport(evidence({ images: Array.from({ length: 10_001 }, () => ({})) })), { code: 'PREFLIGHT_RESOURCE_LIMIT', status: 413 });
});

test('preflight XML is deterministic, complete, escaped, and explicitly non-authoritative', () => {
  const report = buildPreflightReport(evidence({
    fonts: [{ name: 'A&B<review>\'"', embedded: 'no', unicode: 'yes' }],
  }));
  const first = serializePreflightReportXml(report);
  const second = serializePreflightReportXml(report);
  assert.equal(first, second);
  assert.match(first, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/u);
  assert.match(first, new RegExp(`report-sha256="${report.reportSha256}"`, 'u'));
  assert.match(first, /local-only="true" authoritative="false"/u);
  assert.match(first, /<profile id="print-review" fixed="true"\/>/u);
  assert.match(first, /<document sha256="[a-f0-9]{64}" page-count="1"\/>/u);
  assert.match(first, /<check id="fonts\.embedding" status="fail">/u);
  assert.match(first, /<evidence encoding="canonical-json">/u);
  assert.match(first, /A&amp;B&lt;review&gt;&apos;/u);
  assert.match(first, /\\&quot;/u);
  assert.match(first, /<limitations count="2">/u);
  assert.equal(first.endsWith('</preflight-review>\n'), true);
});

test('preflight XML rejects altered reports before serialization', () => {
  const report = buildPreflightReport(evidence());
  assert.throws(
    () => serializePreflightReportXml({ ...report, status: 'pass' }),
    { code: 'INVALID_PREFLIGHT_REPORT' },
  );
  assert.throws(
    () => serializePreflightReportXml({ ...report, unexpected: true }),
    { code: 'INVALID_PREFLIGHT_REPORT' },
  );
});

test('preflight XML rejects proxies whose descriptor and property values disagree', () => {
  const report = buildPreflightReport(evidence());
  const document = new Proxy({ ...report.document }, {
    get(target, key, receiver) {
      return key === 'pageCount' ? 1 : Reflect.get(target, key, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === 'pageCount' ? { ...descriptor, value: 999 } : descriptor;
    },
  });
  assert.throws(
    () => serializePreflightReportXml({ ...report, document }),
    { code: 'INVALID_PREFLIGHT_REPORT' },
  );
});

test('preflight XML rejects inherited JSON hooks that could substitute hashed data', () => {
  const report = buildPreflightReport(evidence());
  const forgedDocument = { ...report.document, pageCount: 999 };
  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true,
    value() { return this === forgedDocument ? report.document : this; },
  });
  try {
    assert.throws(
      () => serializePreflightReportXml({ ...report, document: forgedDocument }),
      { code: 'INVALID_PREFLIGHT_REPORT' },
    );
  } finally {
    delete Object.prototype.toJSON;
  }
});

test('preflight XML requires the complete ordered fixed-profile check set', () => {
  const report = buildPreflightReport(evidence());
  const missingChecks = report.checks.slice(1);
  const missingCounts = { ...report.counts, pass: report.counts.pass - 1 };
  assert.throws(
    () => serializePreflightReportXml(rehashReport(report, {
      checks: missingChecks,
      counts: missingCounts,
    })),
    { code: 'INVALID_PREFLIGHT_REPORT' },
  );

  const duplicateChecks = [...report.checks];
  duplicateChecks[1] = duplicateChecks[0];
  assert.throws(
    () => serializePreflightReportXml(rehashReport(report, { checks: duplicateChecks })),
    { code: 'INVALID_PREFLIGHT_REPORT' },
  );
});
