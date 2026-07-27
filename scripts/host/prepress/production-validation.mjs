import { cancelled, deterministicDigest, fail } from './prepress-support.mjs';

function productionChecks(preflight, inkCoverage, maximumAverageAggregateInkPercent) {
  const averageInkStatus = maximumAverageAggregateInkPercent > 320 ? 'fail' : 'pass';
  return Object.freeze([
    Object.freeze({
      id: 'fixed-print-preflight',
      status: preflight.status === 'fail' ? 'fail' : preflight.status === 'pass' ? 'pass' : 'warning',
      summary: `The fixed print-review profile completed with status ${preflight.status}.`,
      evidence: Object.freeze({ reportSha256: preflight.reportSha256 }),
    }),
    Object.freeze({
      id: 'ink.average-page-aggregate',
      status: averageInkStatus,
      summary: maximumAverageAggregateInkPercent > 320
        ? 'At least one page exceeds the fixed 320% average aggregate CMYK review threshold.'
        : 'Every page is at or below the fixed 320% average aggregate CMYK review threshold.',
      evidence: Object.freeze({
        maximumAverageAggregateInkPercent,
        thresholdPercent: 320,
        pages: inkCoverage.pages.length,
      }),
    }),
    Object.freeze({
      id: 'ink.localized-total-area-coverage',
      status: 'not-checked',
      summary: 'Ghostscript inkcov reports page-average process coverage, not localized TAC hotspots.',
    }),
    Object.freeze({
      id: 'color.output-intent',
      status: 'not-checked',
      summary: 'OutputIntent and characterized printing-condition semantics are not validated.',
    }),
    Object.freeze({
      id: 'print.spot-trapping-rip',
      status: 'not-checked',
      summary: 'Spot aliases, trapping, screening, and production RIP behavior are not validated.',
    }),
    Object.freeze({
      id: 'standards.pdf-x',
      status: 'not-checked',
      summary: 'No PDF/X validator is installed in this trust boundary.',
    }),
  ]);
}

export function createProductionValidationOperation(core) {
  const { runPreflight, analyzeInkCoverage } = core.operations;
  return async function runProductionValidation(documentId, { signal } = {}) {
    cancelled(signal);
    const document = core.store.getDocument(documentId);
    const [preflight, inkCoverage] = await Promise.all([
      runPreflight(documentId, { profile: 'print-review', signal }),
      analyzeInkCoverage(documentId, { signal }),
    ]);
    await core.store.verifySource(documentId);
    if (preflight.document.sha256 !== document.sha256 ||
      inkCoverage.document.sha256 !== document.sha256) {
      fail('PRODUCTION_VALIDATION_SOURCE_MISMATCH', 'Print-production evidence did not bind to one immutable source.', 500);
    }
    const maximumAverageAggregateInkPercent = inkCoverage.pages.reduce(
      (maximum, item) => Math.max(maximum, item.totalInkPercent),
      0,
    );
    const checks = productionChecks(preflight, inkCoverage, maximumAverageAggregateInkPercent);
    const counts = Object.freeze(Object.fromEntries(
      ['pass', 'warning', 'fail', 'not-checked'].map((status) => [
        status,
        checks.filter((check) => check.status === status).length,
      ]),
    ));
    const payload = {
      kind: 'print-production-validation',
      schemaVersion: 1,
      profile: Object.freeze({ id: 'local-print-production-review-v1', fixed: true }),
      sourceSha256: document.sha256,
      pageCount: inkCoverage.pages.length,
      status: counts.fail ? 'fail' : 'review-required',
      authoritative: false,
      certification: false,
      completeForFixedChecks: true,
      counts,
      checks,
      preflight,
      inkCoverage,
      limitations: Object.freeze([
        'This complete source-bound receipt covers only the named fixed local checks.',
        'It is not PDF/X, GWG, Ghent, Certified PDF, OutputIntent, TAC-hotspot, trapping, spot-color, or production-RIP certification.',
      ]),
    };
    return Object.freeze({ ...payload, reportSha256: deterministicDigest(payload) });
  };
}
