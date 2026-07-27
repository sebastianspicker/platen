import { isAbsolute, relative } from 'node:path';
import { runProcess } from '../process-runner.mjs';

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  }
  return value;
}

function workspaceOutput(value, workspace, label = 'output') {
  const checkedWorkspace = absolutePath(workspace, 'workspace');
  const checkedOutput = absolutePath(value, label);
  const pathFromWorkspace = relative(checkedWorkspace, checkedOutput);
  if (!pathFromWorkspace || pathFromWorkspace === '..' || pathFromWorkspace.startsWith('../')) {
    throw new TypeError(`${label} must be a file inside workspace`);
  }
  return checkedOutput;
}

function pdfOutput(value, workspace) {
  const output = workspaceOutput(value, workspace);
  if (!output.toLowerCase().endsWith('.pdf')) throw new TypeError('output must use a .pdf extension');
  return output;
}

function rasterOutput(value, workspace, extension) {
  const output = workspaceOutput(value, workspace);
  if (!output.toLowerCase().endsWith(extension)) throw new TypeError(`output must use a ${extension} extension`);
  return output;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function boundedPoint(value, label) {
  if (!Number.isFinite(value) || value < 72 || value > 14_400) {
    throw new TypeError(`${label} must be from 72 through 14400 points`);
  }
  return String(Number(value.toFixed(3)));
}

function uuid(value, label) {
  if (typeof value !== 'string'
    || !/^uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID string`);
  }
  return value;
}

function deterministicPdfOptions(documentUuid, instanceUuid) {
  return Object.freeze([
    '-dOmitInfoDate=true', '-dOmitID=true',
    `-sDocumentUUID=${uuid(documentUuid, 'documentUuid')}`,
    `-sInstanceUUID=${uuid(instanceUuid, 'instanceUuid')}`,
  ]);
}

function pdfwriteArgs({ input, output, workspace, options = [] }) {
  return Object.freeze([
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite',
    ...options,
    `-sOutputFile=${pdfOutput(output, workspace)}`,
    absolutePath(input, 'input'),
  ]);
}

export function buildGhostscriptRewritePdfArgs(parameters) {
  return pdfwriteArgs(parameters);
}

export function buildGhostscriptOptimizePdfArgs(parameters) {
  return pdfwriteArgs({ ...parameters, options: ['-dPDFSETTINGS=/ebook'] });
}

// FastWebView is Ghostscript's requested rewrite mode. It is not a claim that
// the resulting file meets every consumer's definition of PDF linearization.
export function buildGhostscriptFastWebViewPdfArgs(parameters) {
  return pdfwriteArgs({ ...parameters, options: ['-dFastWebView=true'] });
}

export function buildGhostscriptPostScriptToPdfArgs(parameters) {
  return pdfwriteArgs(parameters);
}

export function buildGhostscriptEpsToPdfArgs(parameters) {
  return pdfwriteArgs({ ...parameters, options: ['-dEPSCrop'] });
}

export function buildGhostscriptSourceToPdfArgs(parameters) {
  return pdfwriteArgs(parameters);
}

export function buildGhostscriptPdfA2Args({ input, output, workspace, outputIccProfile }) {
  return pdfwriteArgs({
    input, output, workspace,
    options: [
      '-dPDFA=2', '-dPDFACompatibilityPolicy=1',
      '-sColorConversionStrategy=RGB',
      `-sOutputICCProfile=${absolutePath(outputIccProfile, 'outputIccProfile')}`,
    ],
  });
}

export function buildGhostscriptPdfXArgs({ input, output, workspace, outputIccProfile }) {
  return pdfwriteArgs({
    input, output, workspace,
    options: [
      '-dPDFX', '-sColorConversionStrategy=CMYK',
      `-sOutputICCProfile=${absolutePath(outputIccProfile, 'outputIccProfile')}`,
    ],
  });
}

export function buildGhostscriptCmykNormalizationArgs({
  input, output, workspace, outputIccProfile, documentUuid, instanceUuid,
}) {
  const profile = workspaceOutput(outputIccProfile, workspace, 'outputIccProfile');
  if (!profile.toLowerCase().endsWith('.icc')) throw new TypeError('outputIccProfile must use an .icc extension');
  return pdfwriteArgs({
    input, output, workspace,
    options: [
      '-q', `--permit-file-read=${profile}`,
      '-dPDFSTOPONWARNING', '-dPDFNOCIDFALLBACK', '-dCompatibilityLevel=1.7',
      '-dAutoRotatePages=/None',
      '-dDownsampleColorImages=false', '-dDownsampleGrayImages=false', '-dDownsampleMonoImages=false',
      '-dPreserveOverprintSettings=true', '-dOverrideICC=false', '-dPreserveSeparation=true',
      '-sColorConversionStrategy=CMYK', '-sBlendConversionStrategy=Simple',
      `-sOutputICCProfile=${profile}`, '-dRenderIntent=1', '-dBlackPtComp=1',
      ...deterministicPdfOptions(documentUuid, instanceUuid),
    ],
  });
}

export function buildGhostscriptNupImpositionArgs({
  input, output, workspace, across, down, sheetWidthPoints, sheetHeightPoints,
  documentUuid, instanceUuid,
}) {
  const columns = boundedInteger(across, 'across', 1, 4);
  const rows = boundedInteger(down, 'down', 1, 4);
  if (columns * rows < 2 || columns * rows > 8) throw new TypeError('N-up layout must contain from 2 through 8 cells');
  return pdfwriteArgs({
    input, output, workspace,
    options: [
      '-q', '-dPDFSTOPONWARNING', '-dPDFNOCIDFALLBACK', '-dCompatibilityLevel=1.7',
      '-dAutoRotatePages=/None',
      '-dDownsampleColorImages=false', '-dDownsampleGrayImages=false', '-dDownsampleMonoImages=false',
      '-dPreserveOverprintSettings=true',
      `-dDEVICEWIDTHPOINTS=${boundedPoint(sheetWidthPoints, 'sheetWidthPoints')}`,
      `-dDEVICEHEIGHTPOINTS=${boundedPoint(sheetHeightPoints, 'sheetHeightPoints')}`,
      '-dFIXEDMEDIA', `-sNupControl=${columns}x${rows}`,
      ...deterministicPdfOptions(documentUuid, instanceUuid),
    ],
  });
}

export function buildGhostscriptFlattenTransparencyArgs(parameters) {
  return pdfwriteArgs({ ...parameters, options: ['-dCompatibilityLevel=1.3'] });
}

export function buildGhostscriptInkCoverageArgs({ input, workspace }) {
  absolutePath(workspace, 'workspace');
  return Object.freeze([
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=inkcov', '-o', '-', absolutePath(input, 'input'),
  ]);
}

export function buildGhostscriptSeparationsArgs({ input, output, workspace, page, dpi }) {
  boundedInteger(page, 'page', 1, 1_000_000);
  boundedInteger(dpi, 'dpi', 18, 300);
  return Object.freeze([
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=tiffsep',
    `-dFirstPage=${page}`, `-dLastPage=${page}`, `-r${dpi}`,
    `-sOutputFile=${rasterOutput(output, workspace, '.tif')}`,
    absolutePath(input, 'input'),
  ]);
}

export function buildGhostscriptOverprintPreviewArgs({ input, output, workspace, page, dpi }) {
  boundedInteger(page, 'page', 1, 1_000_000);
  boundedInteger(dpi, 'dpi', 18, 300);
  return Object.freeze([
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=png16m', '-sOverprint=simulate',
    `-dFirstPage=${page}`, `-dLastPage=${page}`, `-r${dpi}`,
    `-sOutputFile=${rasterOutput(output, workspace, '.png')}`,
    absolutePath(input, 'input'),
  ]);
}

export const GHOSTSCRIPT_OPERATIONS = Object.freeze({
  rewritePdf: buildGhostscriptRewritePdfArgs,
  optimizePdf: buildGhostscriptOptimizePdfArgs,
  rewritePdfForFastWebView: buildGhostscriptFastWebViewPdfArgs,
  convertPostScriptToPdf: buildGhostscriptPostScriptToPdfArgs,
  convertEpsToPdf: buildGhostscriptEpsToPdfArgs,
  convertSourceToPdf: buildGhostscriptSourceToPdfArgs,
  emitPdfA2Target: buildGhostscriptPdfA2Args,
  emitPdfXTarget: buildGhostscriptPdfXArgs,
  normalizeCmykWithIcc: buildGhostscriptCmykNormalizationArgs,
  imposeNup: buildGhostscriptNupImpositionArgs,
  flattenTransparency: buildGhostscriptFlattenTransparencyArgs,
  analyzeInkCoverage: buildGhostscriptInkCoverageArgs,
  renderSeparations: buildGhostscriptSeparationsArgs,
  renderOverprintPreview: buildGhostscriptOverprintPreviewArgs,
});

export class GhostscriptAdapter {
  #registry;
  #runner;

  constructor({ registry, runner = runProcess } = {}) {
    if (!registry || typeof registry.probe !== 'function') throw new TypeError('registry must expose probe(name)');
    if (typeof runner !== 'function') throw new TypeError('runner must be a function');
    this.#registry = registry;
    this.#runner = runner;
  }

  async probe() {
    const engine = await this.#registry.probe('gs');
    return Object.freeze({ name: 'Ghostscript', version: engine.version });
  }

  async execute(operation, parameters, runOptions = {}) {
    const builder = GHOSTSCRIPT_OPERATIONS[operation];
    if (!builder) throw new TypeError(`Unknown Ghostscript operation ${operation}`);
    const args = builder(parameters);
    const engine = await this.#registry.probe('gs');
    return this.#runner({ ...runOptions, cwd: absolutePath(parameters.workspace, 'workspace'), executable: engine.executable, args });
  }
}
