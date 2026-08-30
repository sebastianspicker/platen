import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { runProcess } from './process-runner.mjs';

export const POPPLER_EXECUTABLES = Object.freeze([
  'pdfinfo',
  'pdftotext',
  'pdftocairo',
  'pdffonts',
  'pdfimages',
  'pdfdetach',
  'pdfsig',
  'pdfseparate',
  'pdfunite',
]);
export const OCR_EXECUTABLES = Object.freeze(['tesseract']);
export const GHOSTSCRIPT_EXECUTABLES = Object.freeze(['gs']);
export const LIBREOFFICE_EXECUTABLES = Object.freeze(['soffice']);
export const IMAGEMAGICK_EXECUTABLES = Object.freeze(['magick']);
export const QPDF_EXECUTABLES = Object.freeze(['qpdf']);
export const BUILTIN_EXECUTABLES = Object.freeze([
  ...POPPLER_EXECUTABLES,
  ...OCR_EXECUTABLES,
  ...GHOSTSCRIPT_EXECUTABLES,
  ...LIBREOFFICE_EXECUTABLES,
  ...IMAGEMAGICK_EXECUTABLES,
  ...QPDF_EXECUTABLES,
]);

const DEFAULT_SEARCH_DIRECTORIES = Object.freeze([
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]);
const executableNamePattern = /^[a-z][a-z0-9]*$/;
const probeDefinitions = Object.freeze({
  tesseract: Object.freeze({ args: ['--version'], pattern: /^tesseract\s+(\d+(?:\.\d+){1,3})\b/im }),
  gs: Object.freeze({ args: ['--version'], pattern: /^(\d+(?:\.\d+){1,3})\s*$/m }),
  soffice: Object.freeze({ args: ['--version'], pattern: /LibreOffice\s+(\d+(?:\.\d+){1,3})\b/i }),
  magick: Object.freeze({ args: ['--version'], pattern: /ImageMagick\s+(\d+(?:\.\d+){1,3}(?:-\d+)?)\b/i }),
  qpdf: Object.freeze({ args: ['--version'], pattern: /^qpdf version\s+(\d+(?:\.\d+){1,3})\b/im }),
});
const popplerVersionPattern = /\bversion\s+(\d+(?:\.\d+){1,3})\b/i;

export class EngineRegistryError extends Error {
  constructor(message, { code, engine, cause } = {}) {
    super(message, { cause });
    this.name = 'EngineRegistryError';
    this.code = code;
    this.engine = engine;
  }
}

export async function resolveExecutable(name, {
  directories = DEFAULT_SEARCH_DIRECTORIES,
  accessImpl = access,
} = {}) {
  if (typeof name !== 'string' || !executableNamePattern.test(name)) {
    throw new TypeError('engine name must contain only lowercase ASCII letters and digits');
  }
  if (!Array.isArray(directories) || directories.some((directory) => !isAbsolute(directory))) {
    throw new TypeError('engine search directories must be absolute paths');
  }
  for (const directory of directories) {
    const candidate = join(directory, name);
    try {
      await accessImpl(candidate, constants.X_OK);
      return candidate;
    } catch { /* try the next fixed directory */ }
  }
  throw new EngineRegistryError(`Required engine ${name} was not found`, {
    code: 'ENGINE_NOT_FOUND', engine: name,
  });
}

export class EngineRegistry {
  #resolver;
  #runner;
  #cache = new Map();
  #pending = new Map();

  constructor({ resolver = resolveExecutable, runner = runProcess } = {}) {
    if (typeof resolver !== 'function' || typeof runner !== 'function') {
      throw new TypeError('resolver and runner must be functions');
    }
    this.#resolver = resolver;
    this.#runner = runner;
  }

  async probe(name) {
    if (!BUILTIN_EXECUTABLES.includes(name)) {
      throw new EngineRegistryError(`Unknown built-in engine ${name}`, {
        code: 'ENGINE_UNKNOWN', engine: name,
      });
    }
    if (this.#cache.has(name)) return this.#cache.get(name);
    if (this.#pending.has(name)) return this.#pending.get(name);

    const pending = this.#probeUncached(name)
      .finally(() => {
        if (this.#pending.get(name) === pending) this.#pending.delete(name);
      });
    this.#pending.set(name, pending);
    return pending;
  }

  async #probeUncached(name) {
    const executable = await this.#resolver(name);
    if (typeof executable !== 'string' || !isAbsolute(executable)) {
      throw new EngineRegistryError(`Resolver returned a non-absolute path for ${name}`, {
        code: 'ENGINE_PATH_INVALID', engine: name,
      });
    }
    const probe = probeDefinitions[name] ?? { args: ['-v'], pattern: popplerVersionPattern };
    let versionOutput;
    try {
      const result = await this.#runner({
        executable,
        args: probe.args,
        timeoutMs: 5_000,
        maxStdoutBytes: 16_384,
        maxStderrBytes: 16_384,
      });
      versionOutput = `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      // Some Poppler utilities (notably pdfdetach) print a valid version and
      // deliberately return 99 when invoked without a document.
      if (error?.code !== 'ENGINE_PROCESS_FAILED' || typeof error.stderr !== 'string') throw error;
      versionOutput = error.stderr;
    }
    const match = versionOutput.match(probe.pattern);
    if (!match) {
      throw new EngineRegistryError(`Could not parse ${name} version output`, {
        code: 'ENGINE_VERSION_INVALID', engine: name,
      });
    }
    const record = Object.freeze({ name, executable, version: match[1], available: true });
    this.#cache.set(name, record);
    return record;
  }

  async probeAll() {
    return Promise.all(BUILTIN_EXECUTABLES.map((name) => this.probe(name)));
  }

  clear() {
    this.#cache.clear();
  }
}
