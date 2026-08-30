import { boundedPath, exactPositionals, fail } from './parser-foundation.mjs';

export function parseFastWebView(command, positionals, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!output) fail('CLI_INVALID_OPTION', 'The fast-web-view command requires --output.');
  if (!/\.pdf$/iu.test(output)) fail('CLI_INVALID_OPTION', 'The fast-web-view output must use a .pdf file.');
  return Object.freeze({ command, input: boundedPath(input, 'Input'), output });
}

