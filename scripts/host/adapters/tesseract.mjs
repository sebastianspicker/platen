import { isAbsolute } from 'node:path';
import { runProcess } from '../process-runner.mjs';

const LANGUAGE_PATTERN = /^[a-z0-9_]+(?:\+[a-z0-9_]+){0,7}$/;
const SEGMENTATION_MODES = Object.freeze({ auto: 3, 'single-column': 4, block: 6, sparse: 11 });

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  }
  return value;
}

export function validateOcrLanguage(value) {
  if (typeof value !== 'string' || !LANGUAGE_PATTERN.test(value)) {
    throw new TypeError('language must contain one to eight lowercase Tesseract language identifiers');
  }
  return value;
}

export function buildTesseractLanguagesArgs() {
  return Object.freeze(['--list-langs']);
}

function boundedDpi(value) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 70 || value > 600) throw new TypeError('dpi must be an integer from 70 through 600');
  return value;
}

function segmentationArgs(value = 'auto') {
  if (!Object.hasOwn(SEGMENTATION_MODES, value)) {
    throw new TypeError('segmentation must be auto, single-column, block, or sparse');
  }
  const psm = SEGMENTATION_MODES[value];
  return ['--psm', String(psm)];
}

function commonRecognitionArgs({ input, outputBase, language, dpi, segmentation }) {
  const checkedDpi = boundedDpi(dpi);
  return [
    absolutePath(input, 'input'),
    absolutePath(outputBase, 'outputBase'),
    '-l', validateOcrLanguage(language),
    ...(checkedDpi === null ? [] : ['--dpi', String(checkedDpi)]),
    ...segmentationArgs(segmentation),
    '-c', 'preserve_interword_spaces=1',
  ];
}

function userWordsArgs(value) {
  if (value === undefined) return [];
  return ['--user-words', absolutePath(value, 'userWordsPath')];
}

export function buildTesseractPdfArgs({ input, outputBase, language, dpi, segmentation = 'auto', userWordsPath }) {
  return Object.freeze([
    ...commonRecognitionArgs({ input, outputBase, language, dpi, segmentation }),
    ...userWordsArgs(userWordsPath),
    'pdf', 'tsv',
  ]);
}

export function buildTesseractLayoutArgs({ input, outputBase, language, dpi, segmentation = 'auto', detectTables = false }) {
  if (typeof detectTables !== 'boolean') throw new TypeError('detectTables must be a boolean');
  return Object.freeze([
    ...commonRecognitionArgs({ input, outputBase, language, dpi, segmentation }),
    ...(detectTables ? [
      '-c', 'textord_tabfind_find_tables=1',
      '-c', 'textord_tablefind_recognize_tables=1',
    ] : []),
    'tsv', 'alto',
  ]);
}

const operations = Object.freeze({
  listLanguages: buildTesseractLanguagesArgs,
  recognizePagePdf: buildTesseractPdfArgs,
  recognizeLayout: buildTesseractLayoutArgs,
});

export class TesseractAdapter {
  #registry;
  #runner;

  constructor({ registry, runner = runProcess } = {}) {
    if (!registry || typeof registry.probe !== 'function') throw new TypeError('registry must expose probe(name)');
    if (typeof runner !== 'function') throw new TypeError('runner must be a function');
    this.#registry = registry;
    this.#runner = runner;
  }

  async execute(operation, parameters = {}, runOptions = {}) {
    if (!Object.hasOwn(operations, operation)) throw new TypeError(`Unknown Tesseract operation ${operation}`);
    const builder = operations[operation];
    const args = builder(parameters);
    const engine = await this.#registry.probe('tesseract');
    return this.#runner({ ...runOptions, executable: engine.executable, args });
  }
}
