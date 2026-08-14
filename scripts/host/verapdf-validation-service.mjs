import { createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';

export const SUPPORTED_STANDARD_PROFILES = Object.freeze([
  'pdfa-1a', 'pdfa-1b', 'pdfa-2a', 'pdfa-2b', 'pdfa-2u',
  'pdfa-3a', 'pdfa-3b', 'pdfa-3u', 'pdfa-4', 'pdfa-4e', 'pdfa-4f',
  'pdfua-1', 'pdfua-2',
]);

export const DEFAULT_VERAPDF_VALIDATION_LIMITS = Object.freeze({
  timeoutMs: 5 * 60_000,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  maxJsonDepth: 32,
  maxJsonNodes: 100_000,
});

function fail(code, message, status = 400, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function boundedLimits(value) {
  const result = { ...DEFAULT_VERAPDF_VALIDATION_LIMITS };
  for (const [key, item] of Object.entries(value ?? {})) {
    if (!(key in result) || !Number.isSafeInteger(item) || item < 1
      || item > DEFAULT_VERAPDF_VALIDATION_LIMITS[key]) {
      throw new TypeError('veraPDF validation limits must remain within fixed production maxima.');
    }
    result[key] = item;
  }
  return Object.freeze(result);
}

function inspectJsonShape(value, maximumDepth, maximumNodes) {
  let nodes = 0;
  const stack = [{ value, depth: 1 }];
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > maximumNodes) fail('VERAPDF_REPORT_LIMIT', 'The validator report contains too many JSON values.', 502);
    if (current.depth > maximumDepth) fail('VERAPDF_REPORT_LIMIT', 'The validator report is nested too deeply.', 502);
    if (!current.value || typeof current.value !== 'object') continue;
    if (!Array.isArray(current.value) && Object.getPrototypeOf(current.value) !== Object.prototype) {
      fail('VERAPDF_REPORT_INVALID', 'The validator report contains an unsupported JSON value.', 502);
    }
    for (const child of Object.values(current.value)) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function requiredCounter(object, key, label = key) {
  if (!plainObject(object) || !nonnegativeInteger(object[key])) {
    fail('VERAPDF_REPORT_INVALID', `The validator report has an invalid ${label} counter.`, 502);
  }
  return object[key];
}

function familyFor(profile) {
  return profile.startsWith('pdfa-') ? 'PDF/A' : 'PDF/UA';
}

/**
 * Normalize one completed veraPDF JSON report. Raw rule messages, item names,
 * paths, statements, and contexts are intentionally discarded.
 */
export function parseVeraPdfValidationReport(stdout, {
  profile,
  expectedProfileName,
  engineVersion,
  bundleSha256,
  sourceSha256,
  exitCode,
  limits = DEFAULT_VERAPDF_VALIDATION_LIMITS,
} = {}) {
  if (!SUPPORTED_STANDARD_PROFILES.includes(profile)) throw new TypeError('profile is unsupported.');
  if (typeof expectedProfileName !== 'string' || !expectedProfileName.trim() || expectedProfileName.length > 160) {
    throw new TypeError('expectedProfileName must be a bounded string.');
  }
  if (!/^\d+\.\d+\.\d+$/.test(engineVersion ?? '') || !/^[a-f0-9]{64}$/.test(bundleSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(sourceSha256 ?? '') || ![0, 1].includes(exitCode)) {
    throw new TypeError('Engine, bundle, source, and exit evidence are invalid.');
  }
  if (typeof stdout !== 'string' || !stdout || Buffer.byteLength(stdout) > limits.maxStdoutBytes) {
    fail('VERAPDF_REPORT_LIMIT', 'The validator report is empty or exceeds the local output limit.', 502);
  }
  let root;
  try {
    root = JSON.parse(stdout);
  } catch (error) {
    fail('VERAPDF_REPORT_INVALID', 'The validator did not return valid JSON.', 502, error);
  }
  inspectJsonShape(root, limits.maxJsonDepth, limits.maxJsonNodes);
  if (!plainObject(root) || Object.keys(root).length !== 1 || !plainObject(root.report)) {
    fail('VERAPDF_REPORT_INVALID', 'The validator report envelope is invalid.', 502);
  }
  const report = root.report;
  if (!Array.isArray(report.jobs) || report.jobs.length !== 1 || !plainObject(report.jobs[0])) {
    fail('VERAPDF_REPORT_INVALID', 'The validator report must contain exactly one job.', 502);
  }
  const job = report.jobs[0];
  if (Object.hasOwn(job, 'taskException') || job.jobEndStatus !== 'normal'
    || !Array.isArray(job.validationResult) || job.validationResult.length !== 1
    || !plainObject(job.validationResult[0])) {
    fail('VERAPDF_REPORT_INVALID', 'The validator job did not complete normally with one result.', 502);
  }
  const validation = job.validationResult[0];
  if (validation.profileName !== expectedProfileName || typeof validation.compliant !== 'boolean'
    || !plainObject(validation.details)) {
    fail('VERAPDF_REPORT_INVALID', 'The validator result does not match the requested profile.', 502);
  }
  const counts = Object.freeze({
    passedRules: requiredCounter(validation.details, 'passedRules'),
    failedRules: requiredCounter(validation.details, 'failedRules'),
    passedChecks: requiredCounter(validation.details, 'passedChecks'),
    failedChecks: requiredCounter(validation.details, 'failedChecks'),
  });
  const summary = report.batchSummary;
  if (!plainObject(summary) || requiredCounter(summary, 'totalJobs') !== 1
    || ['failedToParse', 'encrypted', 'outOfMemory', 'veraExceptions']
      .some((key) => requiredCounter(summary, key) !== 0)
    || !plainObject(summary.validationSummary)) {
    fail('VERAPDF_REPORT_INVALID', 'The validator batch summary reports an incomplete or failed job.', 502);
  }
  const validationSummary = summary.validationSummary;
  const compliantJobs = requiredCounter(validationSummary, 'compliant');
  const nonCompliantJobs = requiredCounter(validationSummary, 'nonCompliant');
  const failedJobs = requiredCounter(validationSummary, 'failedJobs');
  const validationJobs = requiredCounter(validationSummary, 'totalJobs');
  const expectedCompliant = validation.compliant ? 1 : 0;
  const expectedNonCompliant = validation.compliant ? 0 : 1;
  if (failedJobs !== 0 || validationJobs !== 1 || compliantJobs !== expectedCompliant
    || nonCompliantJobs !== expectedNonCompliant) {
    fail('VERAPDF_REPORT_INVALID', 'The validator result and batch summary disagree.', 502);
  }
  const buildRecords = report.buildInformation?.releaseDetails;
  if (!Array.isArray(buildRecords) || buildRecords.length < 1 || buildRecords.length > 64
    || !buildRecords.some((entry) => plainObject(entry) && entry.id === 'core' && entry.version === engineVersion)) {
    fail('VERAPDF_REPORT_INVALID', 'The validator report does not bind the probed core version.', 502);
  }
  if ((exitCode === 0 && (!validation.compliant || counts.failedRules || counts.failedChecks))
    || (exitCode === 1 && (validation.compliant || (!counts.failedRules && !counts.failedChecks)))) {
    fail('VERAPDF_REPORT_INVALID', 'The validator exit status and result disagree.', 502);
  }
  return Object.freeze({
    kind: 'standards-validation',
    schemaVersion: 1,
    standard: Object.freeze({ family: familyFor(profile), profile }),
    sourceSha256,
    status: validation.compliant ? 'compliant' : 'noncompliant',
    authoritative: true,
    complete: true,
    counts,
    engine: Object.freeze({ name: 'veraPDF', version: engineVersion, bundleSha256 }),
    limitations: Object.freeze([
      'This receipt proves only the named veraPDF profile and pinned engine version.',
      'It is not accessibility usability, legal, print-production, or PDF/X certification.',
    ]),
  });
}

async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function privateEnvironment(workspace) {
  const environment = {};
  for (const [key, name] of [
    ['HOME', 'home'], ['TMPDIR', 'tmp'], ['XDG_CACHE_HOME', 'cache'],
    ['XDG_CONFIG_HOME', 'config'], ['XDG_RUNTIME_DIR', 'runtime'],
  ]) {
    const directory = join(workspace, name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    environment[key] = directory;
  }
  return Object.freeze(environment);
}

export class VeraPdfValidationService {
  #store;
  #adapter;
  #engine;
  #limits;

  constructor({ store, adapter, engine, limits } = {}) {
    if (!store || !['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob']
      .every((name) => typeof store[name] === 'function')) {
      throw new TypeError('VeraPdfValidationService requires a DocumentStore-compatible store.');
    }
    if (!adapter || typeof adapter.execute !== 'function') {
      throw new TypeError('VeraPdfValidationService requires a veraPDF adapter.');
    }
    if (!plainObject(engine) || !/^\d+\.\d+\.\d+$/.test(engine.version ?? '')
      || !/^[a-f0-9]{64}$/.test(engine.bundleSha256 ?? '') || !plainObject(engine.profileNames)
      || SUPPORTED_STANDARD_PROFILES.some((profile) => typeof engine.profileNames[profile] !== 'string')) {
      throw new TypeError('VeraPdfValidationService requires pinned engine and profile evidence.');
    }
    this.#store = store;
    this.#adapter = adapter;
    this.#engine = Object.freeze({
      version: engine.version,
      bundleSha256: engine.bundleSha256,
      profileNames: Object.freeze({ ...engine.profileNames }),
    });
    this.#limits = boundedLimits(limits);
  }

  async validate(documentId, { profile, signal } = {}) {
    if (profile === 'pdfx') fail('STANDARD_UNSUPPORTED', 'PDF/X validation requires a separate authoritative engine.', 422);
    if (!SUPPORTED_STANDARD_PROFILES.includes(profile)) {
      fail('INVALID_STANDARD_PROFILE', 'Choose a supported fixed PDF/A or PDF/UA profile.');
    }
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    if (signal?.aborted) fail('JOB_CANCELLED', 'The standards validation was cancelled.', 499);
    const document = this.#store.getDocument(documentId);
    await this.#store.verifySource(document.id);
    let workspace;
    let result;
    let failure;
    try {
      workspace = await this.#store.createJobWorkspace(document.id);
      const sourcePath = join(workspace, 'source.pdf');
      await copyFile(this.#store.getSourcePath(document.id), sourcePath, fsConstants.COPYFILE_EXCL);
      await chmod(sourcePath, 0o400);
      const metadata = await lstat(sourcePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || await digestFile(sourcePath) !== document.sha256) {
        fail('SOURCE_INTEGRITY_FAILED', 'The private validation input does not match the immutable source.', 500);
      }
      const environment = await privateEnvironment(workspace);
      let execution;
      try {
        execution = await this.#adapter.execute(profile, sourcePath, {
          cwd: workspace,
          environment,
          signal,
          timeoutMs: this.#limits.timeoutMs,
          maxStdoutBytes: this.#limits.maxStdoutBytes,
          maxStderrBytes: this.#limits.maxStderrBytes,
        });
      } catch (error) {
        if (signal?.aborted || error?.code === 'ENGINE_CANCELLED') {
          fail('JOB_CANCELLED', 'The standards validation was cancelled.', 499, error);
        }
        throw error;
      }
      if (!execution || typeof execution.stdout !== 'string' || ![0, 1].includes(execution.exitCode)) {
        fail('VERAPDF_EXECUTION_INVALID', 'The validator did not return a completed validation result.', 502);
      }
      if (await digestFile(sourcePath) !== document.sha256) {
        fail('SOURCE_INTEGRITY_FAILED', 'The private validation input changed during validation.', 500);
      }
      await this.#store.verifySource(document.id);
      result = parseVeraPdfValidationReport(execution.stdout, {
        profile,
        expectedProfileName: this.#engine.profileNames[profile],
        engineVersion: this.#engine.version,
        bundleSha256: this.#engine.bundleSha256,
        sourceSha256: document.sha256,
        exitCode: execution.exitCode,
        limits: this.#limits,
      });
    } catch (error) {
      failure = error instanceof HostError
        ? error
        : new HostError('STANDARDS_VALIDATION_FAILED', 'The local standards validator could not complete the request.', 502, { cause: error });
    } finally {
      if (workspace) {
        try {
          await this.#store.cleanupJob(workspace);
        } catch (error) {
          failure = new HostError('STANDARDS_CLEANUP_FAILED', 'The private standards workspace could not be removed.', 500, { cause: error });
        }
      }
    }
    if (failure) throw failure;
    return result;
  }
}
