import { extname } from 'node:path';
import { boundedPath, exactPositionals, fail } from './parser-foundation.mjs';

const SCAN_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff']);

export function parseScannerDiscovery(command, positionals, output) {
  exactPositionals(positionals, 0);
  return Object.freeze({ command, output: output ? boundedPath(output, 'Output') : null });
}

export function parseScanAppend(command, positionals, values, output) {
  const [input, scan] = exactPositionals(positionals, 2);
  if (!values.has('after-page') || !output || !/\.pdf$/iu.test(output)) fail('CLI_INVALID_OPTION', 'scan-append requires --after-page and a .pdf --output.');
  const extension = extname(scan).toLowerCase();
  if (!SCAN_EXTENSIONS.has(extension)) fail('CLI_INVALID_OPTION', 'scan-append accepts .png, .jpg, .jpeg, .tif, or .tiff scan input.');
  if (!/^\d+$/u.test(String(values.get('after-page'))) || Number(values.get('after-page')) > 10_000) fail('CLI_INVALID_OPTION', '--after-page must be an integer from 0 through 10000.');
  return Object.freeze({ command, input, scan, extension, afterPage: Number(values.get('after-page')), output: boundedPath(output, 'Output') });
}
