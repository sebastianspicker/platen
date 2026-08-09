import { constants as fsConstants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { HostError } from '../host-error.mjs';
import { runProcess } from '../process-runner.mjs';

export const CUPS_FILTER_PATH = '/usr/sbin/cupsfilter';
const PLAN_LIMIT = 64 * 1024;
const PDF_LIMIT = 64 * 1024 * 1024;

function fail(code, message, status = 503, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function safeEngineError(error, plan = false) {
  if (error instanceof HostError) throw error;
  fail(plan ? 'CUPS_FILTER_PLAN_FAILED' : 'CUPS_FILTER_FAILED', plan
    ? 'The local CUPS filter plan could not be verified.'
    : 'The local CUPS text-to-PDF filter failed.', plan ? 503 : 422, error);
}

function filterLines(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > PLAN_LIMIT) {
    fail('CUPS_FILTER_PLAN_INVALID', 'The local CUPS filter plan is invalid.');
  }
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== 1 || lines[0] !== 'cgtexttopdf') {
    fail('CUPS_FILTER_PLAN_INVALID', 'The required local CUPS text-to-PDF filter is unavailable.');
  }
  return Object.freeze(lines);
}

async function verifyExecutable({ platform, executable, lstatImpl, accessImpl }) {
  if (platform !== 'darwin' || executable !== CUPS_FILTER_PATH) {
    fail('CUPS_FILTER_UNAVAILABLE', 'The fixed macOS CUPS text-to-PDF engine is unavailable.');
  }
  try {
    const metadata = await lstatImpl(executable);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail('CUPS_FILTER_UNAVAILABLE', 'The fixed macOS CUPS text-to-PDF engine is unavailable.');
    }
    await accessImpl(executable, fsConstants.X_OK);
  } catch (error) {
    if (error instanceof HostError) throw error;
    fail('CUPS_FILTER_UNAVAILABLE', 'The fixed macOS CUPS text-to-PDF engine is unavailable.', 503, error);
  }
}

/** Fixed, local-only CUPS adapter. The source path is always a private staged copy. */
export function createCupsfilterAdapter({
  processRunner = runProcess,
  platform = process.platform,
  executable = CUPS_FILTER_PATH,
  lstatImpl = lstat,
  accessImpl = access,
} = {}) {
  if (typeof processRunner !== 'function' || typeof lstatImpl !== 'function' || typeof accessImpl !== 'function') {
    throw new TypeError('CUPS filter adapter dependencies are invalid.');
  }
  const verify = () => verifyExecutable({ platform, executable, lstatImpl, accessImpl });
  const planArgs = (source) => ['--list-filters', '-i', 'text/plain', '-m', 'application/pdf', '--', source];
  const convertArgs = (source) => ['-i', 'text/plain', '-m', 'application/pdf', '--', source];
  return Object.freeze({
    async verifyPlan({ sourcePath, cwd, signal }) {
      await verify();
      try {
        const result = await processRunner({ executable, args: planArgs(sourcePath), cwd, signal,
          timeoutMs: 20_000, maxStdoutBytes: PLAN_LIMIT, maxStderrBytes: PLAN_LIMIT });
        return filterLines(result.stdout);
      } catch (error) { safeEngineError(error, true); }
    },
    async convert({ sourcePath, cwd, signal }) {
      await verify();
      try {
        const result = await processRunner({ executable, args: convertArgs(sourcePath), cwd, signal,
          timeoutMs: 60_000, maxStdoutBytes: PDF_LIMIT, maxStderrBytes: PLAN_LIMIT,
          stdoutEncoding: 'buffer' });
        if (!Buffer.isBuffer(result.stdout) || result.stdout.length < 5 || result.stdout.length > PDF_LIMIT) {
          fail('CUPS_FILTER_OUTPUT_INVALID', 'The local CUPS filter did not produce a bounded PDF.');
        }
        return result.stdout;
      } catch (error) { safeEngineError(error); }
    },
  });
}
