import { boundedPath, exactPositionals, fail } from './parser-foundation.mjs';
import { parseBoundedPageSpec } from './parser-full-page-redaction.mjs';

function color(value) {
  if (typeof value !== 'string' || !/^(?:0|1|0?\.\d{1,6})(?:,(?:0|1|0?\.\d{1,6})){2}$/u.test(value)) fail('CLI_INVALID_OPTION', '--color must be R,G,B with each component from 0 through 1 and at most six decimals.');
  const [r, g, b] = value.split(',').map(Number); return Object.freeze({ r, g, b });
}
export function parsePageBackground(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!values.has('pages') || !values.has('color') || !output || !/\.pdf$/iu.test(output)) fail('CLI_INVALID_OPTION', 'page-background requires --pages, --color R,G,B, and a .pdf --output.');
  return Object.freeze({ command, input, pages: parseBoundedPageSpec(values.get('pages'), 500, 500), color: color(values.get('color')), output: boundedPath(output, 'Output') });
}
