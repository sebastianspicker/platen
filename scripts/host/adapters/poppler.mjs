import { isAbsolute } from 'node:path';
import { runProcess } from '../process-runner.mjs';

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function freezeArgs(args) {
  return Object.freeze(args);
}

export const POPPLER_OPERATION_TOOLS = Object.freeze({
  inspect: 'pdfinfo',
  inspectStdin: 'pdfinfo',
  inspectPage: 'pdfinfo',
  inspectPageStdin: 'pdfinfo',
  inspectPageBoxes: 'pdfinfo',
  inspectMetadata: 'pdfinfo',
  inspectCustomMetadata: 'pdfinfo',
  inspectDestinations: 'pdfinfo',
  inspectUrls: 'pdfinfo',
  inspectStructure: 'pdfinfo',
  extractText: 'pdftotext',
  extractTextStdin: 'pdftotext',
  extractTextRegion: 'pdftotext',
  renderPagePng: 'pdftocairo',
  renderOverlayExactDpiPng: 'pdftocairo',
  renderCropBoxPagePng: 'pdftocairo',
  listFonts: 'pdffonts',
  listImages: 'pdfimages',
  listImagesStdin: 'pdfimages',
  extractImages: 'pdfimages',
  listAttachments: 'pdfdetach',
  extractAttachment: 'pdfdetach',
  verifySignatures: 'pdfsig',
  dumpSignatures: 'pdfsig',
  splitPages: 'pdfseparate',
  mergeDocuments: 'pdfunite',
});

export function buildPdfinfoArgs({ input }) {
  return freezeArgs(['-isodates', absolutePath(input, 'input')]);
}

export function buildPdfinfoStdinArgs() {
  return freezeArgs(['-isodates', '-']);
}

export function buildPdfinfoPageArgs({ input, page }) {
  boundedInteger(page, 'page', 1, 1_000_000);
  return freezeArgs([
    '-f', String(page), '-l', String(page), '-box', '-isodates', absolutePath(input, 'input'),
  ]);
}

export function buildPdfinfoPageStdinArgs({ page }) {
  boundedInteger(page, 'page', 1, 1_000_000);
  return freezeArgs([
    '-f', String(page), '-l', String(page), '-box', '-isodates', '-',
  ]);
}

export function buildPdfinfoBoxesArgs({ input, firstPage, lastPage }) {
  boundedInteger(firstPage, 'firstPage', 1, 1_000_000);
  boundedInteger(lastPage, 'lastPage', firstPage, 1_000_000);
  return freezeArgs([
    '-f', String(firstPage), '-l', String(lastPage), '-box', '-isodates',
    absolutePath(input, 'input'),
  ]);
}

export function buildPdfinfoMetadataArgs({ input }) {
  return freezeArgs(['-meta', absolutePath(input, 'input')]);
}

export function buildPdfinfoCustomMetadataArgs({ input }) {
  return freezeArgs(['-custom', '-isodates', absolutePath(input, 'input')]);
}

export function buildPdfinfoDestinationsArgs({ input }) {
  return freezeArgs(['-dests', '-enc', 'UTF-8', absolutePath(input, 'input')]);
}

export function buildPdfinfoUrlsArgs({ input }) {
  return freezeArgs(['-url', '-enc', 'UTF-8', absolutePath(input, 'input')]);
}

export function buildPdfinfoStructureArgs({ input, includeText = false }) {
  if (typeof includeText !== 'boolean') throw new TypeError('includeText must be a boolean');
  return freezeArgs([
    includeText ? '-struct-text' : '-struct', '-enc', 'UTF-8', absolutePath(input, 'input'),
  ]);
}

export function buildPdftotextArgs({ input, layout = true }) {
  if (typeof layout !== 'boolean') throw new TypeError('layout must be a boolean');
  return freezeArgs([
    '-enc', 'UTF-8',
    ...(layout ? ['-layout'] : []),
    absolutePath(input, 'input'),
    '-',
  ]);
}

export function buildPdftotextStdinArgs({ layout = true } = {}) {
  if (typeof layout !== 'boolean') throw new TypeError('layout must be a boolean');
  return freezeArgs([
    '-enc', 'UTF-8',
    ...(layout ? ['-layout'] : []),
    '-',
    '-',
  ]);
}

export function buildPdftotextRegionArgs({ input, page, region }) {
  boundedInteger(page, 'page', 1, 1_000_000);
  if (!region || typeof region !== 'object' || Array.isArray(region)) {
    throw new TypeError('region must be a pixel rectangle');
  }
  boundedInteger(region.x, 'region.x', 0, 14_400);
  boundedInteger(region.y, 'region.y', 0, 14_400);
  boundedInteger(region.width, 'region.width', 1, 14_400);
  boundedInteger(region.height, 'region.height', 1, 14_400);
  return freezeArgs([
    '-f', String(page), '-l', String(page), '-r', '72',
    '-x', String(region.x), '-y', String(region.y),
    '-W', String(region.width), '-H', String(region.height),
    '-cropbox', '-enc', 'UTF-8', absolutePath(input, 'input'), '-',
  ]);
}

export function buildPdftocairoArgs({ input, outputPrefix, page, maxDimension = 1_600 }) {
  boundedInteger(page, 'page', 1, 1_000_000);
  boundedInteger(maxDimension, 'maxDimension', 256, 4_096);
  return freezeArgs([
    '-png', '-singlefile', '-f', String(page), '-l', String(page), '-scale-to', String(maxDimension),
    absolutePath(input, 'input'),
    absolutePath(outputPrefix, 'outputPrefix'),
  ]);
}

export function buildPdftocairoOverlayExactDpiArgs({ input, outputPrefix, page, dpi }) {
  boundedInteger(page, 'page', 1, 1_000_000);
  boundedInteger(dpi, 'dpi', 36, 240);
  return freezeArgs([
    '-png', '-singlefile', '-f', String(page), '-l', String(page), '-r', String(dpi),
    absolutePath(input, 'input'), absolutePath(outputPrefix, 'outputPrefix'),
  ]);
}

export function buildPdftocairoCropBoxArgs({ input, outputPrefix, page, maxDimension }) {
  boundedInteger(page, 'page', 1, 1_000_000);
  boundedInteger(maxDimension, 'maxDimension', 512, 2_880);
  return freezeArgs([
    '-png', '-singlefile', '-cropbox', '-f', String(page), '-l', String(page), '-scale-to', String(maxDimension),
    absolutePath(input, 'input'),
    absolutePath(outputPrefix, 'outputPrefix'),
  ]);
}

export function buildPdffontsArgs({ input }) {
  return freezeArgs([absolutePath(input, 'input')]);
}

export function buildPdfimagesListArgs({ input }) {
  return freezeArgs(['-list', absolutePath(input, 'input')]);
}

export function buildPdfimagesListStdinArgs() {
  return freezeArgs(['-list', '-']);
}

export function buildPdfimagesExtractArgs({ input, outputPrefix }) {
  return freezeArgs(['-all', absolutePath(input, 'input'), absolutePath(outputPrefix, 'outputPrefix')]);
}

export function buildPdfdetachListArgs({ input }) {
  return freezeArgs(['-list', absolutePath(input, 'input')]);
}

export function buildPdfdetachExtractArgs({ input, attachment, output }) {
  boundedInteger(attachment, 'attachment', 1, 1_000_000);
  return freezeArgs([
    '-save', String(attachment), '-o', absolutePath(output, 'output'), absolutePath(input, 'input'),
  ]);
}

export function buildPdfsigArgs({ input, nssDirectory }) {
  const nssPath = absolutePath(nssDirectory, 'nssDirectory');
  return freezeArgs([
    '-nssdir', `sql:${nssPath}`, '-nocert', '-no-ocsp', absolutePath(input, 'input'),
  ]);
}

export function buildPdfsigDumpArgs({ input, nssDirectory }) {
  const nssPath = absolutePath(nssDirectory, 'nssDirectory');
  return freezeArgs([
    '-nssdir', `sql:${nssPath}`, '-nocert', '-no-ocsp', '-dump', absolutePath(input, 'input'),
  ]);
}

export function buildPdfseparateArgs({ input, outputPattern, firstPage, lastPage }) {
  boundedInteger(firstPage, 'firstPage', 1, 1_000_000);
  boundedInteger(lastPage, 'lastPage', firstPage, 1_000_000);
  const pattern = absolutePath(outputPattern, 'outputPattern');
  if ((pattern.match(/%d/g) ?? []).length !== 1) {
    throw new TypeError('outputPattern must contain exactly one %d placeholder');
  }
  return freezeArgs([
    '-f', String(firstPage), '-l', String(lastPage), absolutePath(input, 'input'), pattern,
  ]);
}

export function buildPdfuniteArgs({ inputs, output }) {
  if (!Array.isArray(inputs) || inputs.length < 2) {
    throw new TypeError('inputs must contain at least two absolute paths');
  }
  const checkedInputs = inputs.map((input, index) => absolutePath(input, `inputs[${index}]`));
  const checkedOutput = absolutePath(output, 'output');
  if (checkedInputs.includes(checkedOutput)) {
    throw new TypeError('output must not replace an input document');
  }
  return freezeArgs([...checkedInputs, checkedOutput]);
}

const builders = Object.freeze({
  inspect: buildPdfinfoArgs,
  inspectStdin: buildPdfinfoStdinArgs,
  inspectPage: buildPdfinfoPageArgs,
  inspectPageStdin: buildPdfinfoPageStdinArgs,
  inspectPageBoxes: buildPdfinfoBoxesArgs,
  inspectMetadata: buildPdfinfoMetadataArgs,
  inspectCustomMetadata: buildPdfinfoCustomMetadataArgs,
  inspectDestinations: buildPdfinfoDestinationsArgs,
  inspectUrls: buildPdfinfoUrlsArgs,
  inspectStructure: buildPdfinfoStructureArgs,
  extractText: buildPdftotextArgs,
  extractTextStdin: buildPdftotextStdinArgs,
  extractTextRegion: buildPdftotextRegionArgs,
  renderPagePng: buildPdftocairoArgs,
  renderOverlayExactDpiPng: buildPdftocairoOverlayExactDpiArgs,
  renderCropBoxPagePng: buildPdftocairoCropBoxArgs,
  listFonts: buildPdffontsArgs,
  listImages: buildPdfimagesListArgs,
  listImagesStdin: buildPdfimagesListStdinArgs,
  extractImages: buildPdfimagesExtractArgs,
  listAttachments: buildPdfdetachListArgs,
  extractAttachment: buildPdfdetachExtractArgs,
  verifySignatures: buildPdfsigArgs,
  dumpSignatures: buildPdfsigDumpArgs,
  splitPages: buildPdfseparateArgs,
  mergeDocuments: buildPdfuniteArgs,
});

export class PopplerAdapter {
  #registry;
  #runner;

  constructor({ registry, runner = runProcess } = {}) {
    if (!registry || typeof registry.probe !== 'function') {
      throw new TypeError('registry must expose probe(name)');
    }
    if (typeof runner !== 'function') throw new TypeError('runner must be a function');
    this.#registry = registry;
    this.#runner = runner;
  }

  async execute(operation, parameters, runOptions = {}) {
    if (!Object.hasOwn(builders, operation) || !Object.hasOwn(POPPLER_OPERATION_TOOLS, operation)) {
      throw new TypeError(`Unknown Poppler operation ${operation}`);
    }
    const builder = builders[operation];
    const tool = POPPLER_OPERATION_TOOLS[operation];
    const args = builder(parameters);
    const engine = await this.#registry.probe(tool);
    return this.#runner({
      ...runOptions,
      executable: engine.executable,
      args,
    });
  }
}
