import { extname, isAbsolute, relative } from 'node:path';
import { runProcess } from '../process-runner.mjs';

const RASTER_EXTENSIONS = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);
const OUTPUT_RASTER_EXTENSIONS = new Set(['.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);
const RASTER_PDF_LIMITS = Object.freeze([
  '-limit', 'memory', '128MiB', '-limit', 'map', '128MiB', '-limit', 'disk', '256MiB',
  '-limit', 'area', '32MP', '-limit', 'width', '8192', '-limit', 'height', '8192',
  '-limit', 'thread', '1', '-limit', 'time', '60',
]);
const RASTER_PDF_INPUT_EXTENSIONS = Object.freeze(new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']));

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  }
  return value;
}

function rasterPath(value, label, allowedExtensions) {
  const path = absolutePath(value, label);
  if (!allowedExtensions.has(extname(path).toLowerCase())) {
    throw new TypeError(`${label} must use a supported raster image extension`);
  }
  return path;
}

function workspaceOutput(value, workspace, extensions) {
  const output = rasterPath(value, 'output', extensions);
  const pathFromWorkspace = relative(absolutePath(workspace, 'workspace'), output);
  if (!pathFromWorkspace || pathFromWorkspace === '..' || pathFromWorkspace.startsWith('../')) {
    throw new TypeError('output must be a file inside workspace');
  }
  return output;
}

function workspaceInput(value, workspace, extensions) {
  const input = rasterPath(value, 'input', extensions);
  const pathFromWorkspace = relative(absolutePath(workspace, 'workspace'), input);
  if (!pathFromWorkspace || pathFromWorkspace === '..' || pathFromWorkspace.startsWith('../')) {
    throw new TypeError('input must be a file inside workspace');
  }
  return input;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function commonArgs({ input, workspace }) {
  return [
    '-define', `registry:temporary-path=${absolutePath(workspace, 'workspace')}`,
    rasterPath(input, 'input', RASTER_EXTENSIONS),
  ];
}

export function buildImageMagickRasterToPdfArgs({ input, output, workspace }) {
  const pdfOutput = absolutePath(output, 'output');
  const pathFromWorkspace = relative(absolutePath(workspace, 'workspace'), pdfOutput);
  if (!pdfOutput.toLowerCase().endsWith('.pdf') || !pathFromWorkspace || pathFromWorkspace === '..' || pathFromWorkspace.startsWith('../')) {
    throw new TypeError('output must be a .pdf file inside workspace');
  }
  const source = rasterPath(input, 'input', RASTER_PDF_INPUT_EXTENSIONS);
  const sourceArg = source.toLowerCase().endsWith('.png') ? `png:${source}` : source;
  return Object.freeze([
    ...RASTER_PDF_LIMITS,
    '-define', `registry:temporary-path=${absolutePath(workspace, 'workspace')}`,
    sourceArg, '-strip', `pdf:${pdfOutput}`,
  ]);
}

export function buildImageMagickPngStdinToPdfArgs({ output, workspace }) {
  const pdfOutput = absolutePath(output, 'output');
  const pathFromWorkspace = relative(absolutePath(workspace, 'workspace'), pdfOutput);
  if (!pdfOutput.toLowerCase().endsWith('.pdf') || !pathFromWorkspace
    || pathFromWorkspace === '..' || pathFromWorkspace.startsWith('../')) {
    throw new TypeError('output must be a .pdf file inside workspace');
  }
  return Object.freeze([
    ...RASTER_PDF_LIMITS,
    '-define', `registry:temporary-path=${absolutePath(workspace, 'workspace')}`,
    'png:-', '-strip', `pdf:${pdfOutput}`,
  ]);
}

export function buildImageMagickTransformRasterArgs({ input, output, workspace, maxDimension, rotateDegrees = 0 }) {
  boundedInteger(maxDimension, 'maxDimension', 64, 8_192);
  boundedInteger(rotateDegrees, 'rotateDegrees', 0, 359);
  return Object.freeze([
    ...commonArgs({ input, workspace }), '-auto-orient', '-strip', '-resize', `${maxDimension}x${maxDimension}>`,
    ...(rotateDegrees ? ['-rotate', String(rotateDegrees)] : []),
    workspaceOutput(output, workspace, OUTPUT_RASTER_EXTENSIONS),
  ]);
}

export function buildImageMagickTiffPreviewArgs({ input, output, workspace, maxDimension }) {
  boundedInteger(maxDimension, 'maxDimension', 64, 8_192);
  const source = workspaceInput(input, workspace, new Set(['.tif', '.tiff']));
  return Object.freeze([
    '-limit', 'memory', '128MiB', '-limit', 'map', '128MiB', '-limit', 'disk', '256MiB', '-limit', 'area', '32MP', '-limit', 'thread', '1', '-limit', 'time', '60',
    '-define', `registry:temporary-path=${absolutePath(workspace, 'workspace')}`, `tiff:${source}`, '-strip', '-resize', `${maxDimension}x${maxDimension}>`, `png:${workspaceOutput(output, workspace, new Set(['.png']))}`,
  ]);
}

export const IMAGEMAGICK_OPERATIONS = Object.freeze({
  convertRasterToPdf: buildImageMagickRasterToPdfArgs,
  convertPngStdinToPdf: buildImageMagickPngStdinToPdfArgs,
  transformRaster: buildImageMagickTransformRasterArgs,
  tiffPreview: buildImageMagickTiffPreviewArgs,
});

export class ImageMagickAdapter {
  #registry;
  #runner;

  constructor({ registry, runner = runProcess } = {}) {
    if (!registry || typeof registry.probe !== 'function') throw new TypeError('registry must expose probe(name)');
    if (typeof runner !== 'function') throw new TypeError('runner must be a function');
    this.#registry = registry;
    this.#runner = runner;
  }

  async execute(operation, parameters, runOptions = {}) {
    if (!Object.hasOwn(IMAGEMAGICK_OPERATIONS, operation)) throw new TypeError(`Unknown ImageMagick operation ${operation}`);
    const builder = IMAGEMAGICK_OPERATIONS[operation];
    const args = builder(parameters);
    const engine = await this.#registry.probe('magick');
    return this.#runner({ ...runOptions, cwd: absolutePath(parameters.workspace, 'workspace'), executable: engine.executable, args });
  }
}
