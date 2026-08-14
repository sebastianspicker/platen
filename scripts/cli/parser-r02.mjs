import { extname } from 'node:path';
import {
  boundedPath, exactPositionals, fail, positiveInteger,
} from './parser-foundation.mjs';

function exactOutput(output, extension, command) {
  if (!output || extname(output).toLowerCase() !== extension) {
    fail('CLI_INVALID_OPTION', `${command} requires a ${extension} --output.`);
  }
  return boundedPath(output, 'Output');
}

export function parsePostscriptConversion(command, positionals, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!['.ps', '.eps'].includes(extname(input).toLowerCase())) {
    fail('CLI_INVALID_OPTION', 'convert-postscript-local requires one .ps or .eps input.');
  }
  return Object.freeze({ command, input, output: exactOutput(output, '.pdf', command) });
}

export function parseHtmlConversion(command, positionals, output) {
  const [input] = exactPositionals(positionals, 1);
  if (extname(input).toLowerCase() !== '.html') {
    fail('CLI_INVALID_OPTION', 'convert-html-local requires one .html input.');
  }
  return Object.freeze({ command, input, output: exactOutput(output, '.pdf', command) });
}

export function parseCadPdfCreation(command, positionals, output) {
  const [input] = exactPositionals(positionals, 1);
  if (extname(input).toLowerCase() !== '.dxf') {
    fail('CLI_INVALID_OPTION', 'create-cad-pdf-local requires one .dxf input.');
  }
  return Object.freeze({ command, input, output: exactOutput(output, '.pdf', command) });
}

export function parseStructuredExport(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  const format = values.get('format');
  if (!['rtf', 'html', 'xml'].includes(format)) {
    fail('CLI_INVALID_OPTION', 'export-structured-local requires --format rtf, html, or xml.');
  }
  return Object.freeze({
    command, input, format, output: exactOutput(output, `.${format}`, command),
  });
}

export function parseOptimizeCompress(command, positionals, output) {
  const [input] = exactPositionals(positionals, 1);
  if (extname(input).toLowerCase() !== '.pdf') {
    fail('CLI_INVALID_OPTION', 'optimize-compress-local requires one .pdf input.');
  }
  return Object.freeze({ command, input, output: exactOutput(output, '.pdf', command) });
}

export function parsePagePngExport(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  if (extname(input).toLowerCase() !== '.pdf') {
    fail('CLI_INVALID_OPTION', 'export-page-png-local requires one .pdf input.');
  }
  if (!values.has('page') || !values.has('dpi')) {
    fail('CLI_INVALID_OPTION', 'export-page-png-local requires --page and --dpi.');
  }
  const page = positiveInteger(values.get('page'), '--page', 10_000);
  const dpi = positiveInteger(values.get('dpi'), '--dpi', 150);
  if (![72, 150].includes(dpi)) {
    fail('CLI_INVALID_OPTION', '--dpi must be 72 or 150 for export-page-png-local.');
  }
  return Object.freeze({
    command, input, page, dpi, output: exactOutput(output, '.png', command),
  });
}
