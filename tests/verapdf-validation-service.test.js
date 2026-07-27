import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseVeraPdfValidationReport,
  SUPPORTED_STANDARD_PROFILES,
  VeraPdfValidationService,
} from '../scripts/host/verapdf-validation-service.mjs';

const VERSION = '1.30.1';
const BUNDLE_SHA256 = 'b'.repeat(64);
const SOURCE = Buffer.from('%PDF-1.7\nstandards fixture\n%%EOF\n');
const SOURCE_SHA256 = createHash('sha256').update(SOURCE).digest('hex');
const PROFILE_NAMES = Object.freeze(Object.fromEntries(
  SUPPORTED_STANDARD_PROFILES.map((profile) => [profile, `${profile} validation profile`]),
));

function report({
  profile = 'pdfa-2u',
  compliant = true,
  failedRules = compliant ? 0 : 1,
  failedChecks = compliant ? 0 : 2,
  mutate = (value) => value,
} = {}) {
  const value = {
    report: {
      buildInformation: {
        releaseDetails: [
          { id: 'core', version: VERSION, buildDate: '2026-01-01T00:00:00Z' },
          { id: 'gui', version: VERSION, buildDate: '2026-01-01T00:00:00Z' },
        ],
      },
      jobs: [{
        itemDetails: { name: '/private/job/source.pdf', size: SOURCE.length },
        validationResult: [{
          profileName: PROFILE_NAMES[profile],
          compliant,
          details: { passedRules: 80, failedRules, passedChecks: 400, failedChecks },
        }],
        jobEndStatus: 'normal',
      }],
      batchSummary: {
        totalJobs: 1,
        failedToParse: 0,
        encrypted: 0,
        outOfMemory: 0,
        veraExceptions: 0,
        validationSummary: {
          compliant: compliant ? 1 : 0,
          nonCompliant: compliant ? 0 : 1,
          failedJobs: 0,
          totalJobs: 1,
        },
      },
    },
  };
  return JSON.stringify(mutate(value));
}

function parse(stdout, { profile = 'pdfa-2u', exitCode = 0, limits } = {}) {
  return parseVeraPdfValidationReport(stdout, {
    profile,
    expectedProfileName: PROFILE_NAMES[profile],
    engineVersion: VERSION,
    bundleSha256: BUNDLE_SHA256,
    sourceSha256: SOURCE_SHA256,
    exitCode,
    limits,
  });
}

test('veraPDF parser returns only a source-bound normalized authoritative receipt', () => {
  const receipt = parse(report());
  assert.deepEqual(receipt.standard, { family: 'PDF/A', profile: 'pdfa-2u' });
  assert.equal(receipt.status, 'compliant');
  assert.equal(receipt.authoritative, true);
  assert.equal(receipt.complete, true);
  assert.deepEqual(receipt.counts, {
    passedRules: 80, failedRules: 0, passedChecks: 400, failedChecks: 0,
  });
  assert.deepEqual(receipt.engine, { name: 'veraPDF', version: VERSION, bundleSha256: BUNDLE_SHA256 });
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes('/private/job'), false);
  assert.equal(serialized.includes('itemDetails'), false);
  assert.equal(serialized.includes('statement'), false);

  const ua = parse(report({ profile: 'pdfua-1' }), { profile: 'pdfua-1' });
  assert.equal(ua.standard.family, 'PDF/UA');
});

test('veraPDF parser accepts only exit 1 as completed noncompliance and binds every summary', () => {
  const receipt = parse(report({ compliant: false }), { exitCode: 1 });
  assert.equal(receipt.status, 'noncompliant');
  assert.equal(receipt.counts.failedChecks, 2);

  assert.throws(() => parse(report({ compliant: false }), { exitCode: 0 }), { code: 'VERAPDF_REPORT_INVALID' });
  assert.throws(() => parse(report(), { exitCode: 1 }), { code: 'VERAPDF_REPORT_INVALID' });
  assert.throws(() => parse(report({ compliant: false, failedRules: 0, failedChecks: 0 }), { exitCode: 1 }), { code: 'VERAPDF_REPORT_INVALID' });
  assert.throws(() => parse(report({ mutate: (value) => {
    value.report.batchSummary.validationSummary.compliant = 0;
    value.report.batchSummary.validationSummary.nonCompliant = 1;
    return value;
  } })), { code: 'VERAPDF_REPORT_INVALID' });
});

test('veraPDF parser rejects malformed, operational, ambiguous, deep, and oversized reports', () => {
  assert.throws(() => parse('{'), { code: 'VERAPDF_REPORT_INVALID' });
  assert.throws(() => parse(report({ mutate: (value) => {
    value.report.jobs.push(structuredClone(value.report.jobs[0])); return value;
  } })), { code: 'VERAPDF_REPORT_INVALID' });
  assert.throws(() => parse(report({ mutate: (value) => {
    value.report.jobs[0].taskException = { message: '/private/secret' }; return value;
  } })), { code: 'VERAPDF_REPORT_INVALID' });
  assert.throws(() => parse(report({ mutate: (value) => {
    value.report.jobs[0].jobEndStatus = 'failed'; return value;
  } })), { code: 'VERAPDF_REPORT_INVALID' });
  assert.throws(() => parse(report({ mutate: (value) => {
    value.report.batchSummary.failedToParse = 1; return value;
  } })), { code: 'VERAPDF_REPORT_INVALID' });
  assert.throws(() => parse(report({ mutate: (value) => {
    value.report.buildInformation.releaseDetails[0].version = '9.9.9'; return value;
  } })), { code: 'VERAPDF_REPORT_INVALID' });
  assert.throws(() => parse(report(), { limits: {
    timeoutMs: 1, maxStdoutBytes: 16, maxStderrBytes: 1, maxJsonDepth: 32, maxJsonNodes: 100_000,
  } }), { code: 'VERAPDF_REPORT_LIMIT' });
  assert.throws(() => parse(report({ mutate: (value) => {
    let cursor = value.report;
    for (let index = 0; index < 40; index += 1) { cursor.extra = {}; cursor = cursor.extra; }
    return value;
  } })), { code: 'VERAPDF_REPORT_LIMIT' });
});

async function serviceFixture(context, execute) {
  const root = await mkdtemp(join(tmpdir(), 'verapdf-service-test-'));
  const sourcePath = join(root, 'immutable.pdf');
  await writeFile(sourcePath, SOURCE, { mode: 0o400 });
  let cleanupCount = 0;
  let verificationCount = 0;
  const store = {
    getDocument: (id) => ({ id, sha256: SOURCE_SHA256 }),
    getSourcePath: () => sourcePath,
    verifySource: async () => {
      verificationCount += 1;
      const current = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
      if (current !== SOURCE_SHA256) throw new Error('immutable source changed');
      return true;
    },
    createJobWorkspace: async () => {
      const path = join(root, `job-${cleanupCount}`);
      await mkdir(path, { mode: 0o700 });
      return path;
    },
    cleanupJob: async (path) => { cleanupCount += 1; await rm(path, { recursive: true, force: true }); },
  };
  context.after(() => rm(root, { recursive: true, force: true }));
  const service = new VeraPdfValidationService({
    store,
    adapter: { execute },
    engine: { version: VERSION, bundleSha256: BUNDLE_SHA256, profileNames: PROFILE_NAMES },
  });
  return { service, sourcePath, state: () => ({ cleanupCount, verificationCount }) };
}

test('veraPDF service validates only a private immutable copy with private process directories', async (context) => {
  let invocation;
  const { service, sourcePath, state } = await serviceFixture(context, async (...args) => {
    invocation = args;
    return { stdout: report(), stderr: '', exitCode: 0 };
  });
  const receipt = await service.validate('document-1', { profile: 'pdfa-2u' });
  assert.equal(receipt.sourceSha256, SOURCE_SHA256);
  assert.equal(invocation[0], 'pdfa-2u');
  assert.notEqual(invocation[1], sourcePath);
  assert.equal(invocation[1].endsWith('/source.pdf'), true);
  assert.equal(await readFile(sourcePath, 'utf8'), SOURCE.toString('utf8'));
  assert.deepEqual(Object.keys(invocation[2].environment).sort(), ['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR'].sort());
  assert.ok(Object.values(invocation[2].environment).every((path) => path.startsWith(`${invocation[2].cwd}/`)));
  assert.deepEqual(state(), { cleanupCount: 1, verificationCount: 2 });
});

test('veraPDF service rejects unsupported PDF/X, cancellation, input mutation, and always cleans up', async (context) => {
  const mutating = await serviceFixture(context, async (_profile, input) => {
    await chmod(input, 0o600);
    await writeFile(input, 'mutated');
    return { stdout: report(), stderr: '', exitCode: 0 };
  });
  await assert.rejects(mutating.service.validate('document-1', { profile: 'pdfx' }), { code: 'STANDARD_UNSUPPORTED', status: 422 });
  await assert.rejects(mutating.service.validate('document-1', { profile: 'pdfa-2u' }), { code: 'SOURCE_INTEGRITY_FAILED' });
  assert.equal(mutating.state().cleanupCount, 1);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(mutating.service.validate('document-1', { profile: 'pdfa-2u', signal: cancelled.signal }), { code: 'JOB_CANCELLED', status: 499 });
});
