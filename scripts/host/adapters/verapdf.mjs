import { isAbsolute } from 'node:path';
import { runProcess } from '../process-runner.mjs';
import { VERAPDF_SUPPORTED_VERSION } from '../verapdf-bundle-loader.mjs';

export const VERAPDF_PROFILE_MAP = Object.freeze({
  'pdfa-1a': '1a', 'pdfa-1b': '1b', 'pdfa-2a': '2a', 'pdfa-2b': '2b', 'pdfa-2u': '2u',
  'pdfa-3a': '3a', 'pdfa-3b': '3b', 'pdfa-3u': '3u', 'pdfa-4': '4', 'pdfa-4e': '4e',
  'pdfa-4f': '4f', 'pdfua-1': 'ua1', 'pdfua-2': 'ua2',
});

const REQUIRED_FLAVOURS = Object.freeze(Object.values(VERAPDF_PROFILE_MAP));

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  return value;
}

function checkedRunOptions(value, { requireCwd = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('runOptions must be an object');
  if (requireCwd) absolutePath(value.cwd, 'cwd');
  const safe = {};
  for (const key of ['cwd', 'environment', 'signal', 'timeoutMs', 'maxStdoutBytes', 'maxStderrBytes']) {
    if (value[key] !== undefined) safe[key] = value[key];
  }
  return Object.freeze(safe);
}

function checkedBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || bundle.version !== VERAPDF_SUPPORTED_VERSION
    || !absolutePath(bundle.launcher, 'bundle.launcher') || !bundle.profileMap || typeof bundle.profileMap !== 'object') {
    throw new TypeError('bundle must be a verified veraPDF launch descriptor');
  }
  for (const [profile, flavour] of Object.entries(VERAPDF_PROFILE_MAP)) {
    if (bundle.profileMap[profile] !== flavour) throw new TypeError('bundle must expose the fixed veraPDF profile map');
  }
  return bundle;
}

export function buildVeraPdfValidationArgs(profile, input) {
  const flavour = VERAPDF_PROFILE_MAP[profile];
  if (!flavour) throw new TypeError('profile must be a supported fixed veraPDF profile');
  return Object.freeze(['--format', 'json', '--loglevel', '0', '--disableerrormessages', '--maxfailuresdisplayed', '1', '--flavour', flavour, absolutePath(input, 'input')]);
}

export function parseVeraPdfVersion(stdout) {
  if (typeof stdout !== 'string') throw new TypeError('veraPDF version output must be a string');
  const match = /^veraPDF\s+(\d+\.\d+\.\d+)\s*$/u.exec(stdout.split(/\r?\n/u, 1)[0]);
  if (!match) throw new Error('veraPDF version output was not recognized');
  return match[1];
}

export function parseVeraPdfProfileList(stdout) {
  if (typeof stdout !== 'string') throw new TypeError('veraPDF profile list output must be a string');
  if (Buffer.byteLength(stdout) > 64 * 1024) throw new Error('veraPDF profile list exceeds the probe limit');
  const records = {};
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || /^veraPDF supported PDF\/A and PDF\/UA profiles:$/u.test(line)) continue;
    const match = /^([a-z0-9]{1,8})\s+-\s+([^\u0000-\u001f\u007f]{1,160})$/u.exec(line);
    if (!match || Object.hasOwn(records, match[1])) throw new Error('veraPDF profile list was not recognized');
    records[match[1]] = match[2].trim();
  }
  if (REQUIRED_FLAVOURS.some((flavour) => !Object.hasOwn(records, flavour))) {
    throw new Error('veraPDF profile list is incomplete');
  }
  return Object.freeze(records);
}

export class VeraPdfAdapter {
  #bundle;
  #runner;

  constructor({ bundle, runner = runProcess } = {}) {
    this.#bundle = checkedBundle(bundle);
    if (typeof runner !== 'function') throw new TypeError('runner must be a function');
    this.#runner = runner;
  }

  async probe({ cwd, environment, signal } = {}) {
    const options = checkedRunOptions({ cwd, environment, signal });
    const versionResult = await this.#runner({
      ...options, executable: this.#bundle.launcher, args: Object.freeze(['--version']),
      timeoutMs: 5_000, maxStdoutBytes: 16 * 1024, maxStderrBytes: 16 * 1024,
    });
    const version = parseVeraPdfVersion(versionResult.stdout);
    if (version !== this.#bundle.version) throw new Error('Trusted veraPDF bundle version mismatch');
    const listResult = await this.#runner({
      ...options, executable: this.#bundle.launcher, args: Object.freeze(['--list']),
      timeoutMs: 10_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 16 * 1024,
    });
    const listedProfiles = parseVeraPdfProfileList(listResult.stdout);
    const profileNames = Object.freeze(Object.fromEntries(
      Object.entries(VERAPDF_PROFILE_MAP).map(([profile, flavour]) => [profile, listedProfiles[flavour]]),
    ));
    return Object.freeze({ version, profiles: Object.freeze([...REQUIRED_FLAVOURS].sort()), profileNames });
  }

  async execute(profile, input, runOptions = {}) {
    const args = buildVeraPdfValidationArgs(profile, input);
    const options = checkedRunOptions(runOptions);
    try {
      const result = await this.#runner({ ...options, executable: this.#bundle.launcher, args });
      if (result?.exitCode !== 0 && result?.exitCode !== 1) throw new Error('veraPDF returned an unexpected status');
      return Object.freeze({ ...result, completed: true, compliant: result.exitCode === 0 });
    } catch (error) {
      if (error?.exitCode !== 1) throw error;
      return Object.freeze({ stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: 1, signal: error.signal ?? null, completed: true, compliant: false });
    }
  }
}
