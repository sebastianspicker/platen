import { exactPositionals, fail } from './parser-foundation.mjs';

export function parseProfessionalCapability(command, positionals, values, output) {
  const capabilityId = values.get('capability-id');
  if (!capabilityId) fail('CLI_INVALID_OPTION', 'professional-capability requires --capability-id.');
  exactPositionals(positionals, 0);
  return Object.freeze({ command, capabilityId, context: {}, output });
}
