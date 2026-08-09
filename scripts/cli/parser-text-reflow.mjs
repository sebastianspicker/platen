import { boundedPath, exactPositionals, fail } from './parser-foundation.mjs';

/**
 * Parse the dedicated source-bound text-reflow command.
 *
 * Shared parser wiring intentionally remains in parser.mjs. This module only
 * owns the command's positional and path contract.
 */
export function parseTextReflow(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  const request = values.get('request');
  if (!request || !/\.json$/iu.test(request) || !output || !/\.pdf$/iu.test(output)) {
    fail(
      'CLI_INVALID_OPTION',
      'text-reflow requires INPUT.pdf, --request REQUEST.json, and --output OUTPUT.pdf.',
    );
  }
  return Object.freeze({
    command,
    input: boundedPath(input, 'Input'),
    requestPath: boundedPath(request, 'Request'),
    output,
  });
}

