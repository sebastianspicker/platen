import { HostError } from './host-error.mjs';

const MAX_TAG_RECORDS = 50_000;
const STANDARD_TAG_ROLES = new Set([
  'Document', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC', 'TOCI',
  'Index', 'NonStruct', 'Private', 'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
  'Span', 'Quote', 'Note', 'Reference', 'BibEntry', 'Code', 'Link', 'Annot', 'Ruby',
  'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP', 'Figure', 'Formula', 'Form', 'Artifact',
]);

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

export function summarizeTagRoles(structure) {
  const lines = structure?.taggedStructure?.lines;
  if (!Array.isArray(lines)) {
    return Object.freeze({ recordCount: 0, roleCounts: Object.freeze({}), unknownRoleCount: 0, hierarchyCoverage: 'unknown', malformedDepthTransitionCount: 0, headingCount: 0, headingSequenceViolation: false, invalidListRelationshipCount: 0, unknownListRelationshipCount: 0, invalidTableRelationshipCount: 0, unknownTableRelationshipCount: 0 });
  }
  if (lines.length > MAX_TAG_RECORDS) fail('ACCESSIBILITY_TAG_LIMIT', `Tag-role review is limited to ${MAX_TAG_RECORDS} structure records.`, 413);
  const counts = new Map(); const stack = [];
  let unknownRoleCount = 0; let headingCount = 0; let previousHeadingLevel = null; let headingSequenceViolation = false;
  let invalidListRelationshipCount = 0; let unknownListRelationshipCount = 0; let invalidTableRelationshipCount = 0; let unknownTableRelationshipCount = 0; let malformedDepthTransitionCount = 0; let previousDepth = null;
  for (const [index, line] of lines.entries()) {
    const value = String(line?.value ?? ''); const role = value.match(/^([A-Za-z][A-Za-z0-9]*)(?:\s|\(|$)/u)?.[1] ?? null; const roleKnown = Boolean(role && STANDARD_TAG_ROLES.has(role));
    if (!roleKnown) unknownRoleCount += 1;
    const validDepth = Number.isSafeInteger(line?.depth) && line.depth >= 0 && line.depth % 2 === 0; const depth = validDepth ? line.depth : 0;
    if (!validDepth || (index === 0 && depth !== 0) || (previousDepth !== null && depth > previousDepth && depth !== previousDepth + 2)) malformedDepthTransitionCount += 1;
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const parent = stack.at(-1) ?? null; const parentRole = parent?.role ?? null; const parentKnown = parent?.roleKnown === true; previousDepth = depth;
    if (!roleKnown) { stack.push({ depth, role: null, roleKnown: false }); continue; }
    counts.set(role, (counts.get(role) ?? 0) + 1);
    const heading = /^H([1-6])$/u.exec(role);
    if (heading) { const level = Number(heading[1]); if (headingCount === 0 ? level !== 1 : level > previousHeadingLevel + 1) headingSequenceViolation = true; previousHeadingLevel = level; headingCount += 1; }
    const expectedListParent = role === 'LI' ? 'L' : (role === 'Lbl' || role === 'LBody') ? 'LI' : null;
    if (expectedListParent) { if (!parentKnown) unknownListRelationshipCount += 1; else if (parentRole !== expectedListParent) invalidListRelationshipCount += 1; }
    const expectedTableParents = role === 'TR' ? ['Table', 'THead', 'TBody', 'TFoot'] : (role === 'TH' || role === 'TD') ? ['TR'] : null;
    if (expectedTableParents) { if (!parentKnown) unknownTableRelationshipCount += 1; else if (!expectedTableParents.includes(parentRole)) invalidTableRelationshipCount += 1; }
    stack.push({ depth, role, roleKnown: true });
  }
  const hierarchyCoverage = !unknownRoleCount && !malformedDepthTransitionCount ? 'complete' : 'unknown';
  return Object.freeze({ recordCount: lines.length, roleCounts: Object.freeze(Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)))), unknownRoleCount, hierarchyCoverage, malformedDepthTransitionCount, headingCount, headingSequenceViolation, invalidListRelationshipCount, unknownListRelationshipCount, invalidTableRelationshipCount, unknownTableRelationshipCount });
}
