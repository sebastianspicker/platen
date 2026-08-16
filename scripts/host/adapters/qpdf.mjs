import { isAbsolute, relative } from 'node:path';
import { runProcess } from '../process-runner.mjs';

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  }
  return value;
}

function workspaceOutput(value, workspace) {
  const checkedWorkspace = absolutePath(workspace, 'workspace');
  const checkedOutput = absolutePath(value, 'output');
  const fromWorkspace = relative(checkedWorkspace, checkedOutput);
  if (!fromWorkspace || fromWorkspace === '..' || fromWorkspace.startsWith('../')) {
    throw new TypeError('output must be a file inside workspace');
  }
  if (!checkedOutput.toLowerCase().endsWith('.pdf')) {
    throw new TypeError('output must use a .pdf extension');
  }
  return checkedOutput;
}

export function buildQpdfLinearizeArgs({ input, output, workspace }) {
  return Object.freeze([
    '--linearize', absolutePath(input, 'input'), workspaceOutput(output, workspace),
  ]);
}

export function buildQpdfCheckLinearizationArgs({ input }) {
  return Object.freeze(['--check-linearization', absolutePath(input, 'input')]);
}

export const QPDF_OPERATIONS = Object.freeze({
  linearize: buildQpdfLinearizeArgs,
  linearizePdf: buildQpdfLinearizeArgs,
  checkLinearization: buildQpdfCheckLinearizationArgs,
  checkLinearized: buildQpdfCheckLinearizationArgs,
});

export class QpdfAdapter {
  #registry;
  #runner;

  constructor({ registry, runner = runProcess } = {}) {
    if (!registry || typeof registry.probe !== 'function') throw new TypeError('registry must expose probe(name)');
    if (typeof runner !== 'function') throw new TypeError('runner must be a function');
    this.#registry = registry;
    this.#runner = runner;
  }

  async probe() {
    const engine = await this.#registry.probe('qpdf');
    return Object.freeze({ name: 'qpdf', version: engine.version });
  }

  async execute(operation, parameters, runOptions = {}) {
    if (!Object.hasOwn(QPDF_OPERATIONS, operation)) throw new TypeError(`Unknown qpdf operation ${operation}`);
    const builder = QPDF_OPERATIONS[operation];
    const args = builder(parameters);
    const engine = await this.#registry.probe('qpdf');
    return this.#runner({
      ...runOptions,
      cwd: absolutePath(parameters.workspace ?? parameters.input.replace(/\/[^/]*$/u, ''), 'workspace'),
      executable: engine.executable,
      args,
    });
  }
}
