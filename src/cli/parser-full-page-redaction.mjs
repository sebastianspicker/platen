import { boundedPath, exactPositionals, fail } from './parser-foundation.mjs';

export function parseBoundedPageSpec(value, maximum = 100, limit = 32) {
  if (typeof value !== 'string' || !value.trim()) fail('CLI_INVALID_OPTION', '--pages must contain comma-separated pages or ranges.');
  const pages = new Set();
  let previous = 0;
  for (const token of value.split(',')) {
    const match = token.trim().match(/^(\d+)(?:-(\d+))?$/u);
    if (!match) fail('CLI_INVALID_OPTION', '--pages must contain comma-separated pages or ranges such as 1,3-5.');
    const first = Number(match[1]); const last = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > maximum) fail('CLI_INVALID_OPTION', `--pages must contain ascending pages from 1 through ${maximum}.`);
    if (first <= previous) fail('CLI_INVALID_OPTION', '--pages must be unique and ascending.');
    for (let page = first; page <= last; page += 1) {
      pages.add(page);
      if (pages.size > limit) fail('CLI_INVALID_OPTION', `--pages may contain at most ${limit} targets.`);
    }
    previous = last;
  }
  const result = [...pages].sort((left, right) => left - right);
  if (!result.length) fail('CLI_INVALID_OPTION', '--pages must contain at least one target.');
  return Object.freeze(result);
}

export function parseFullPageRedactionBatch(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!values.has('pages') || !output || !/\.pdf$/iu.test(output)) fail('CLI_INVALID_OPTION', 'redact-pages requires --pages and a .pdf --output.');
  return Object.freeze({ command, input, pages: parseBoundedPageSpec(values.get('pages')), output: boundedPath(output, 'Output') });
}

export function parsePrinterMarks(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!values.has('pages') || !output || !/\.pdf$/iu.test(output)) fail('CLI_INVALID_OPTION', 'printer-marks requires --pages and a .pdf --output.');
  return Object.freeze({ command, input, pages: parseBoundedPageSpec(values.get('pages'), 500, 500), output: boundedPath(output, 'Output') });
}
