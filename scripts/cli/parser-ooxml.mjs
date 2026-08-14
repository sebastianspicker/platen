import { boundedPath, exactPositionals, fail } from './parser-foundation.mjs';

export function parseOoxmlExport(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  const format = values.get('format');
  if (!['word', 'excel', 'powerpoint'].includes(format)) fail('CLI_INVALID_OPTION', '--format must be word, excel, or powerpoint for export-ooxml.');
  if (!output) fail('CLI_INVALID_OPTION', 'The export-ooxml command requires --output.');
  const extension = { word: '.docx', excel: '.xlsx', powerpoint: '.pptx' }[format];
  if (!output.toLowerCase().endsWith(extension)) fail('CLI_INVALID_OPTION', `The export-ooxml output must use the ${extension} extension.`);
  return Object.freeze({ command, input, output: boundedPath(output, 'Output'), format });
}
