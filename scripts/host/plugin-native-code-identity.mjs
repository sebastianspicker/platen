import { HostError } from './host-error.mjs';
import { runProcess } from './process-runner.mjs';
import {
  NATIVE_PLUGIN_IDENTIFIERS,
  validateNativeExecutablePair,
} from './plugin-native-supervisor-contract.mjs';

const CODESIGN = '/usr/bin/codesign';
const PLUTIL = '/usr/bin/plutil';
const CODE_HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const CODESIGN_OUTPUT_LIMIT = 64 * 1024;
const CODESIGN_TIMEOUT_MS = 5_000;
const RUNTIME_FLAG = 0x0001_0000;

function fail(cause) {
  throw new HostError(
    'PLUGIN_NATIVE_CODE_IDENTITY_FAILED',
    'The native plugin executable did not satisfy the signed release identity.',
    503,
    cause === undefined ? {} : { cause },
  );
}

function exactlyOne(lines, prefix) {
  const matches = lines.filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) fail();
  return matches[0].slice(prefix.length);
}

export function parseCodesignDetails(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > CODESIGN_OUTPUT_LIMIT) fail();
  const lines = output.split(/\r?\n/u).filter(Boolean);
  const flagLine = lines.filter((line) => line.startsWith('CodeDirectory '));
  if (flagLine.length !== 1) fail();
  const flags = /\bflags=0x([0-9a-f]+)(?:\([^)]*\))?/u.exec(flagLine[0]);
  const cdHash = exactlyOne(lines, 'CDHash=');
  const teamIdentifier = exactlyOne(lines, 'TeamIdentifier=');
  if (!flags || !CODE_HASH.test(cdHash)) fail();
  return Object.freeze({
    executable: exactlyOne(lines, 'Executable='),
    identifier: exactlyOne(lines, 'Identifier='),
    teamIdentifier,
    cdHash,
    hardenedRuntime: (Number.parseInt(flags[1], 16) & RUNTIME_FLAG) === RUNTIME_FLAG,
  });
}

function exactEntitlements(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === 1
    && value['com.apple.security.app-sandbox'] === true;
}

function assertEvidence(evidence, expected) {
  if (evidence.executable !== expected.executable || evidence.identifier !== expected.identifier
    || evidence.teamIdentifier !== expected.teamIdentifier || evidence.cdHash !== expected.cdHash
    || evidence.hardenedRuntime !== true) fail();
  return evidence;
}

async function codesign(runner, args, signal) {
  return runner({
    executable: CODESIGN,
    args,
    signal,
    timeoutMs: CODESIGN_TIMEOUT_MS,
    maxStdoutBytes: CODESIGN_OUTPUT_LIMIT,
    maxStderrBytes: CODESIGN_OUTPUT_LIMIT,
  });
}

async function display(runner, target, signal) {
  const result = await codesign(runner, ['--display', '--verbose=4', target], signal);
  return parseCodesignDetails(`${result.stdout}${result.stderr}`);
}

async function verify(runner, target, requirement, signal) {
  await codesign(runner, [
    '--verify', '--strict=all', '--all-architectures', '--verbose=4',
    '--test-requirement', `=${requirement}`, target,
  ], signal);
}

async function readEntitlements(runner, executable, signal) {
  const extracted = await codesign(
    runner,
    ['--display', '--entitlements', '-', '--xml', executable],
    signal,
  );
  const parsed = await runner({
    executable: PLUTIL,
    args: ['-convert', 'json', '-o', '-', '--', '-'],
    stdin: Buffer.from(extracted.stdout, 'utf8'),
    signal,
    timeoutMs: CODESIGN_TIMEOUT_MS,
    maxStdoutBytes: CODESIGN_OUTPUT_LIMIT,
    maxStderrBytes: CODESIGN_OUTPUT_LIMIT,
  });
  let value;
  try { value = JSON.parse(parsed.stdout); } catch (error) { fail(error); }
  if (!exactEntitlements(value)) fail();
}

/**
 * Production macOS identity verifier. It uses the platform codesign verifier
 * for strict all-architecture static checks and PID-bound dynamic checks. The
 * expected release policy must come from the signed host application.
 */
export class DarwinPluginCodeIdentityVerifier {
  #pair;
  #runner;
  #platform;

  constructor({ supervisor, worker, policy, runner = runProcess, platform = process.platform } = {}) {
    if (typeof runner !== 'function') throw new TypeError('Native code identity runner must be callable.');
    this.#pair = validateNativeExecutablePair({ supervisor, worker, policy });
    this.#runner = runner;
    this.#platform = platform;
  }

  async verifyStaticPair({ signal } = {}) {
    if (this.#platform !== 'darwin') fail();
    const { supervisor, worker, policy } = this.#pair;
    try {
      await this.#verifyStatic({
        executable: supervisor.executable,
        identifier: NATIVE_PLUGIN_IDENTIFIERS.supervisor,
        cdHash: policy.supervisorCdHash,
        requirement: this.#pair.requirements.supervisor,
        signal,
      });
      await this.#verifyStatic({
        executable: worker.executable,
        identifier: NATIVE_PLUGIN_IDENTIFIERS.worker,
        cdHash: policy.workerCdHash,
        requirement: this.#pair.requirements.worker,
        signal,
      });
      return true;
    } catch (error) {
      if (error instanceof HostError && error.code === 'PLUGIN_NATIVE_CODE_IDENTITY_FAILED') throw error;
      fail(error);
    }
  }

  async verifyLiveSupervisor({ pid, signal } = {}) {
    return this.#verifyLive({
      pid,
      executable: this.#pair.supervisor.executable,
      identifier: NATIVE_PLUGIN_IDENTIFIERS.supervisor,
      cdHash: this.#pair.policy.supervisorCdHash,
      requirement: this.#pair.requirements.supervisor,
      signal,
    });
  }

  async verifyLiveWorker({ pid, signal } = {}) {
    return this.#verifyLive({
      pid,
      executable: this.#pair.worker.executable,
      identifier: NATIVE_PLUGIN_IDENTIFIERS.worker,
      cdHash: this.#pair.policy.workerCdHash,
      requirement: this.#pair.requirements.worker,
      signal,
    });
  }

  async #verifyStatic(expected) {
    await verify(this.#runner, expected.executable, expected.requirement, expected.signal);
    assertEvidence(await display(this.#runner, expected.executable, expected.signal), {
      ...expected,
      teamIdentifier: this.#pair.policy.teamIdentifier,
    });
    await readEntitlements(this.#runner, expected.executable, expected.signal);
  }

  async #verifyLive(expected) {
    if (!Number.isSafeInteger(expected.pid) || expected.pid < 1 || this.#platform !== 'darwin') fail();
    const target = `+${expected.pid}`;
    try {
      await verify(this.#runner, target, expected.requirement, expected.signal);
      return assertEvidence(await display(this.#runner, target, expected.signal), {
        ...expected,
        teamIdentifier: this.#pair.policy.teamIdentifier,
      });
    } catch (error) {
      if (error instanceof HostError && error.code === 'PLUGIN_NATIVE_CODE_IDENTITY_FAILED') throw error;
      fail(error);
    }
  }
}
