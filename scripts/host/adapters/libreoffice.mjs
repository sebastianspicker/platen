import { basename, extname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from '../process-runner.mjs';

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  }
  return value;
}

function expectedPdfOutput(input, workspace) {
  const source = absolutePath(input, 'input');
  const outputDirectory = absolutePath(workspace, 'workspace');
  return join(outputDirectory, `${basename(source, extname(source))}.pdf`);
}

export function buildLibreOfficeToPdfArgs({ input, output, workspace }) {
  const outputDirectory = absolutePath(workspace, 'workspace');
  const expected = expectedPdfOutput(input, workspace);
  const checkedOutput = absolutePath(output, 'output');
  const pathFromWorkspace = relative(outputDirectory, checkedOutput);
  if (pathFromWorkspace === '..' || pathFromWorkspace.startsWith('../') || !pathFromWorkspace) {
    throw new TypeError('output must be a file inside workspace');
  }
  if (checkedOutput !== expected) {
    throw new TypeError('output must match LibreOffice\'s deterministic PDF name inside workspace');
  }
  return Object.freeze([
    '--headless', '--nologo', '--nodefault', '--nofirststartwizard',
    `-env:UserInstallation=${pathToFileURL(join(outputDirectory, 'libreoffice-profile')).href}`,
    '--convert-to', 'pdf:writer_pdf_Export', '--outdir', outputDirectory,
    absolutePath(input, 'input'),
  ]);
}

export class LibreOfficeAdapter {
  #registry;
  #runner;

  constructor({ registry, runner = runProcess } = {}) {
    if (!registry || typeof registry.probe !== 'function') throw new TypeError('registry must expose probe(name)');
    if (typeof runner !== 'function') throw new TypeError('runner must be a function');
    this.#registry = registry;
    this.#runner = runner;
  }

  async execute(operation, parameters, runOptions = {}) {
    if (operation !== 'convertOfficeToPdf') throw new TypeError(`Unknown LibreOffice operation ${operation}`);
    const args = buildLibreOfficeToPdfArgs(parameters);
    const engine = await this.#registry.probe('soffice');
    const workspace = absolutePath(parameters.workspace, 'workspace');
    return this.#runner({
      ...runOptions,
      cwd: workspace,
      environment: {
        HOME: workspace,
        TMPDIR: workspace,
        XDG_CACHE_HOME: workspace,
        XDG_CONFIG_HOME: workspace,
        XDG_RUNTIME_DIR: workspace,
        SAL_USE_VCLPLUGIN: 'svp',
      },
      executable: engine.executable,
      args,
    });
  }
}
