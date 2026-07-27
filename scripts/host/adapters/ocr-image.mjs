import { extname, isAbsolute, relative } from 'node:path';
import { runProcess } from '../process-runner.mjs';

const RASTER = new Set(['.png', '.tif', '.tiff', '.jpg', '.jpeg']);
const PRESETS = new Set(['none', 'document', 'bilevel']);
function absolute(value, label) { if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new TypeError(`${label} must be an absolute path without NUL bytes`); return value; }
function inside(value, workspace, label) { const path = absolute(value, label); const from = relative(absolute(workspace, 'workspace'), path); if (!from || from === '..' || from.startsWith('../')) throw new TypeError(`${label} must be inside workspace`); if (!RASTER.has(extname(path).toLowerCase())) throw new TypeError(`${label} must be a supported raster image`); return path; }
function integer(value, label, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${label} must be an integer from ${min} through ${max}`); return value; }
function region(value) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'height,width,x,y') throw new TypeError('region must contain exactly x, y, width, and height'); const result = {}; for (const key of ['x', 'y', 'width', 'height']) { if (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1) throw new TypeError(`region.${key} must be normalized from 0 through 1`); result[key] = value[key]; } if (!(result.width > 0 && result.height > 0 && result.x + result.width <= 1 && result.y + result.height <= 1)) throw new TypeError('region must remain inside the image'); return result; }
function presetArgs(preset, width, height) {
  if (!PRESETS.has(preset)) throw new TypeError('preset must be none, document, or bilevel');
  if (preset === 'none') return [];
  return [
    '-colorspace', 'Gray', '-deskew', '40%', '-despeckle', '-auto-level',
    ...(preset === 'bilevel' ? ['-threshold', '60%', '-type', 'bilevel'] : []),
    '-gravity', 'center', '-extent', `${width}x${height}`, '+repage',
  ];
}

export function buildOcrImageCleanupArgs({ input, output, workspace, imageWidth, imageHeight, dpi = 300, preset = 'document' }) {
  const source = inside(input, workspace, 'input'); const destination = inside(output, workspace, 'output');
  if (source === destination) throw new TypeError('output must differ from input');
  const width = integer(imageWidth, 'imageWidth', 16, 16_384); const height = integer(imageHeight, 'imageHeight', 16, 16_384); integer(dpi, 'dpi', 72, 600);
  if (width * height > 100_000_000) throw new TypeError('OCR image exceeds the pixel limit');
  return Object.freeze(['-define', `registry:temporary-path=${absolute(workspace, 'workspace')}`, source, '-units', 'PixelsPerInch', '-density', String(dpi), '-alpha', 'off', ...presetArgs(preset, width, height), destination]);
}
export function buildOcrImageCropArgs({ input, output, workspace, imageWidth, imageHeight, region: value, dpi = 300, preset = 'document' }) {
  const source = inside(input, workspace, 'input'); const destination = inside(output, workspace, 'output');
  if (source === destination) throw new TypeError('output must differ from input');
  const width = integer(imageWidth, 'imageWidth', 16, 16_384); const height = integer(imageHeight, 'imageHeight', 16, 16_384); integer(dpi, 'dpi', 72, 600); const normalized = region(value);
  if (width * height > 100_000_000) throw new TypeError('OCR image exceeds the pixel limit');
  const cropWidth = Math.max(1, Math.round(width * normalized.width)); const cropHeight = Math.max(1, Math.round(height * normalized.height)); const x = Math.min(width - cropWidth, Math.round(width * normalized.x)); const y = Math.min(height - cropHeight, Math.round(height * normalized.y));
  if (cropWidth < 16 || cropHeight < 16) throw new TypeError('region must cover at least 16 by 16 pixels');
  return Object.freeze(['-define', `registry:temporary-path=${absolute(workspace, 'workspace')}`, source, '-units', 'PixelsPerInch', '-density', String(dpi), '-alpha', 'off', '-crop', `${cropWidth}x${cropHeight}+${x}+${y}`, '+repage', ...presetArgs(preset, cropWidth, cropHeight), destination]);
}
const operations = Object.freeze({ cleanup: buildOcrImageCleanupArgs, crop: buildOcrImageCropArgs });
export class OcrImageAdapter {
  #registry; #runner;
  constructor({ registry, runner = runProcess } = {}) { if (!registry || typeof registry.probe !== 'function') throw new TypeError('registry must expose probe(name)'); if (typeof runner !== 'function') throw new TypeError('runner must be a function'); this.#registry = registry; this.#runner = runner; }
  async execute(operation, parameters, runOptions = {}) { const builder = operations[operation]; if (!builder) throw new TypeError(`Unknown OCR image operation ${operation}`); const args = builder(parameters); const engine = await this.#registry.probe('magick'); return this.#runner({ ...runOptions, cwd: absolute(parameters.workspace, 'workspace'), executable: engine.executable, args }); }
}
