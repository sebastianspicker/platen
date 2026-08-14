import { extname, isAbsolute, relative } from 'node:path';
import { runProcess } from '../process-runner.mjs';

const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.webp']);
export const DEFAULT_RASTER_OVERLAY_FONT = '/System/Library/Fonts/SFNS.ttf';

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  }
  return value;
}

function workspaceRaster(value, workspace, label) {
  const file = absolutePath(value, label);
  if (!RASTER_EXTENSIONS.has(extname(file).toLowerCase())) {
    throw new TypeError(`${label} must use a supported raster extension`);
  }
  const fromWorkspace = relative(absolutePath(workspace, 'workspace'), file);
  if (!fromWorkspace || fromWorkspace === '..' || fromWorkspace.startsWith('../')) {
    throw new TypeError(`${label} must be a file inside workspace`);
  }
  return file;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function color(value) {
  if (value !== undefined && !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new TypeError('overlay color must be a six-digit hexadecimal color');
  }
  return value ?? '#000000';
}

function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith('@')) {
    throw new TypeError('overlay text must be a short printable literal and must not start with @');
  }
  return value;
}

const GRAVITY = Object.freeze({
  watermark: 'Center', header: 'North', footer: 'South', bates: 'SouthEast', 'redaction-label': 'NorthWest',
});

export function buildRasterMutationArgs({ input, output, workspace, fontPath = DEFAULT_RASTER_OVERLAY_FONT, rotateDegrees = 0, crop, resize, overlay, redactions = [] }) {
  integer(rotateDegrees, 'rotateDegrees', 0, 270);
  if (![0, 90, 180, 270].includes(rotateDegrees)) throw new TypeError('rotateDegrees must be 0, 90, 180, or 270');
  if (crop) {
    integer(crop.x, 'crop.x', 0, 8_192); integer(crop.y, 'crop.y', 0, 8_192);
    integer(crop.width, 'crop.width', 1, 8_192); integer(crop.height, 'crop.height', 1, 8_192);
  }
  if (resize) {
    integer(resize.width, 'resize.width', 64, 2_048); integer(resize.height, 'resize.height', 64, 2_048);
  }
  if (!Array.isArray(redactions) || redactions.length > 64) throw new TypeError('redactions must contain at most 64 rectangles');
  const args = [
    '-define', `registry:temporary-path=${absolutePath(workspace, 'workspace')}`,
    absolutePath(input, 'input'), '-auto-orient',
  ];
  if (rotateDegrees) args.push('-rotate', String(rotateDegrees));
  if (crop) args.push('-crop', `${crop.width}x${crop.height}+${crop.x}+${crop.y}`, '+repage');
  if (resize) args.push('-resize', `${resize.width}x${resize.height}!`);
  if (overlay) {
    const gravity = GRAVITY[overlay.placement];
    if (!gravity) throw new TypeError('overlay placement is invalid');
    args.push('-gravity', gravity, '-font', absolutePath(fontPath, 'fontPath'), '-fill', color(overlay.color), '-pointsize', String(integer(overlay.pointSize, 'overlay.pointSize', 8, 144)), '-annotate', `+${integer(overlay.offsetX ?? 24, 'overlay.offsetX', 0, 1_024)}+${integer(overlay.offsetY ?? 24, 'overlay.offsetY', 0, 1_024)}`, text(overlay.text));
  }
  for (const rectangle of redactions) {
    integer(rectangle.x, 'redaction.x', 0, 8_192); integer(rectangle.y, 'redaction.y', 0, 8_192);
    integer(rectangle.width, 'redaction.width', 1, 8_192); integer(rectangle.height, 'redaction.height', 1, 8_192);
    args.push('-fill', '#000000', '-stroke', 'none', '-draw', `rectangle ${rectangle.x},${rectangle.y} ${rectangle.x + rectangle.width - 1},${rectangle.y + rectangle.height - 1}`);
  }
  const checkedOutput = workspaceRaster(output, workspace, 'output');
  args.push('-strip');
  if (extname(checkedOutput).toLowerCase() === '.png') args.push('-define', 'png:color-type=6');
  args.push(checkedOutput);
  return Object.freeze(args);
}

export function buildRasterRegionAnalysisArgs({ input, workspace, region }) {
  if (!region || typeof region !== 'object' || Array.isArray(region)) {
    throw new TypeError('region must be a raster rectangle');
  }
  integer(region.x, 'region.x', 0, 8_192);
  integer(region.y, 'region.y', 0, 8_192);
  integer(region.width, 'region.width', 1, 8_192);
  integer(region.height, 'region.height', 1, 8_192);
  return Object.freeze([
    workspaceRaster(input, workspace, 'input'),
    '-alpha', 'off',
    '-crop', `${region.width}x${region.height}+${region.x}+${region.y}`,
    '+repage', '-colorspace', 'sRGB',
    '-format', '%[fx:maxima]', 'info:',
  ]);
}

export class RasterMutationAdapter {
  #registry;
  #runner;

  constructor({ registry, runner = runProcess } = {}) {
    if (!registry || typeof registry.probe !== 'function') throw new TypeError('registry must expose probe(name)');
    if (typeof runner !== 'function') throw new TypeError('runner must be a function');
    this.#registry = registry;
    this.#runner = runner;
  }

  async mutate(parameters, runOptions = {}) {
    const args = buildRasterMutationArgs(parameters);
    const engine = await this.#registry.probe('magick');
    return this.#runner({ ...runOptions, cwd: absolutePath(parameters.workspace, 'workspace'), executable: engine.executable, args });
  }

  async analyzeRegion(parameters, runOptions = {}) {
    const args = buildRasterRegionAnalysisArgs(parameters);
    const engine = await this.#registry.probe('magick');
    return this.#runner({ ...runOptions, cwd: absolutePath(parameters.workspace, 'workspace'), executable: engine.executable, args });
  }
}
