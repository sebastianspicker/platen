import { exactPositionals, fail, boundedPath } from './parser-foundation.mjs';

const GROUP_TERM = /^(\d+)(?:-(\d+))?:(on|off|visible|hidden)$/u;
const MAX_GROUP_INDEX = 1_000_000;
const MAX_CHANGES = 100;

export function parseLayerDefaults(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  const syntax = values.get('changes');
  if (!syntax) fail('CLI_INVALID_OPTION', 'The layer-defaults command requires --changes GROUP:VISIBILITY[,GROUP...].');
  if (!output) fail('CLI_INVALID_OPTION', 'The layer-defaults command requires --output.');
  const changes = [];
  let previous = -1;
  for (const term of syntax.split(',')) {
    const match = GROUP_TERM.exec(term);
    if (!match) fail('CLI_INVALID_OPTION', '--changes entries must use N:on, N:off, N:visible, or N:hidden (ranges use N-M).');
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end > MAX_GROUP_INDEX) {
      fail('CLI_INVALID_OPTION', '--changes group indexes must be ascending safe integers.');
    }
    if (end - start + 1 > MAX_CHANGES - changes.length || start <= previous) {
      fail('CLI_INVALID_OPTION', '--changes ranges must be non-overlapping, strictly ascending, and contain at most 100 groups.');
    }
    const visible = match[3] === 'on' || match[3] === 'visible';
    for (let groupIndex = start; groupIndex <= end; groupIndex += 1) changes.push(Object.freeze({ groupIndex, visible }));
    previous = end;
  }
  return Object.freeze({ command, input, output: boundedPath(output, 'Output'), changes: Object.freeze(changes) });
}
