import assert from 'node:assert/strict';
import test from 'node:test';
import { runPrepressCommand } from '../scripts/cli/commands/prepress.mjs';
import { parseCliArguments } from '../scripts/cli/parser.mjs';
import { buildPreflightReport } from '../scripts/host/preflight-rules.mjs';

const sha256 = 'a'.repeat(64);

function report(profile = 'archive-review') {
  return buildPreflightReport({
    profile,
    document: { sha256 },
    inspection: { pageCount: 1, encrypted: 'no', javascript: 'no' },
    structure: {
      sourceDigest: sha256,
      pageRange: { firstPage: 1, lastPage: 1, truncated: false },
      pageBoxes: [{
        page: 1,
        widthPoints: 612,
        heightPoints: 792,
        boxes: { mediaBox: { left: 0, bottom: 0, right: 612, top: 792 } },
      }],
      xmpMetadata: { present: true },
    },
    fonts: [],
    images: [],
  });
}

function runtime(outputs) {
  return {
    cancelled: () => {},
    copyExclusive: async () => {},
    emit: async () => {},
    outputValue: async (_command, _stdout, value) => outputs.push(value),
  };
}

test('R08 preflight CLI validates the same report before JSON or XML export', async () => {
  const value = report();
  const application = { prepress: { runPreflight: async () => value } };
  const document = { id: 'document' };
  const json = [];
  await runPrepressCommand(
    application,
    { operation: 'preflight', profile: 'archive-review', format: 'json' },
    document,
    null,
    undefined,
    runtime(json),
  );
  assert.deepEqual(json, [value]);

  const xml = [];
  await runPrepressCommand(
    application,
    { operation: 'preflight', profile: 'archive-review', format: 'xml' },
    document,
    null,
    undefined,
    runtime(xml),
  );
  assert.match(xml[0], /^<\?xml version="1\.0" encoding="UTF-8"\?>/u);
  assert.match(xml[0], new RegExp(`report-sha256="${value.reportSha256}"`, 'u'));
});

test('R08 preflight CLI rejects an unvalidated JSON report before output', async () => {
  const outputs = [];
  const application = {
    prepress: { runPreflight: async () => ({ ...report(), filePath: '/private/report.json' }) },
  };
  await assert.rejects(
    () => runPrepressCommand(
      application,
      { operation: 'preflight', profile: 'archive-review', format: 'json' },
      { id: 'document' },
      null,
      undefined,
      runtime(outputs),
    ),
    { code: 'INVALID_PREFLIGHT_REPORT' },
  );
  assert.deepEqual(outputs, []);
});

test('R08 preflight CLI binds JSON and XML reports to the requested profile', async () => {
  for (const format of ['json', 'xml']) {
    const outputs = [];
    const application = { prepress: { runPreflight: async () => report('archive-review') } };
    await assert.rejects(
      () => runPrepressCommand(
        application,
        { operation: 'preflight', profile: 'print-review', format },
        { id: 'document' },
        null,
        undefined,
        runtime(outputs),
      ),
      { code: 'INVALID_PREFLIGHT_REPORT', status: 502 },
    );
    assert.deepEqual(outputs, []);
  }
});

test('R08 preflight CLI exposes only JSON and XML report formats', () => {
  assert.throws(
    () => parseCliArguments([
      'prepress', 'source.pdf', '--operation', 'preflight', '--format', 'pdf',
    ]),
    { code: 'CLI_INVALID_OPTION' },
  );
});
