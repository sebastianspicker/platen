import { extname } from 'node:path';
import { boundedPath, exactPositionals, fail } from './parser-foundation.mjs';

export function parsePrintToPdf(command, positionals, output) {
  const [input] = exactPositionals(positionals, 1);
  if (extname(input).toLowerCase() !== '.txt') fail('CLI_INVALID_OPTION', 'print-to-pdf-local requires one .txt input.');
  if (!output || extname(output).toLowerCase() !== '.pdf') fail('CLI_INVALID_OPTION', 'print-to-pdf-local requires a .pdf --output.');
  return Object.freeze({ command, input: boundedPath(input, 'Input'), output: boundedPath(output, 'Output') });
}
