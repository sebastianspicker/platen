import { HostError } from './host-error.mjs';

const MAX_TAG_RECORDS = 50_000;
const STANDARD_TAG_ROLES = new Set([
  'Document', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC', 'TOCI',
  'Index', 'NonStruct', 'Private', 'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
  'Span', 'Quote', 'Note', 'Reference', 'BibEntry', 'Code', 'Link', 'Annot', 'Ruby',
  'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP', 'Figure', 'Formula', 'Form', 'Artifact',
]);
const LIST_PARENT_ROLES = new Map([
  ['LI', ['L']],
  ['Lbl', ['LI']],
  ['LBody', ['LI']],
]);
const TABLE_PARENT_ROLES = new Map([
  ['TR', ['Table', 'THead', 'TBody', 'TFoot']],
  ['TH', ['TR']],
  ['TD', ['TR']],
]);
const RELATIONSHIP_COUNT_KEYS = new Map([
  ['list', { invalid: 'invalidListRelationshipCount', unknown: 'unknownListRelationshipCount' }],
  ['table', { invalid: 'invalidTableRelationshipCount', unknown: 'unknownTableRelationshipCount' }],
]);

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

function createRoleState() {
  return {
    counts: new Map(), stack: [], unknownRoleCount: 0, malformedDepthTransitionCount: 0,
    previousDepth: null, headingCount: 0, previousHeadingLevel: null, headingSequenceViolation: false,
    invalidListRelationshipCount: 0, unknownListRelationshipCount: 0,
    invalidTableRelationshipCount: 0, unknownTableRelationshipCount: 0,
  };
}

function parentAtRecordDepth(state, depth) {
  while (state.stack.length && state.stack.at(-1).depth >= depth) state.stack.pop();
  return state.stack.at(-1) ?? null;
}

function normalizeRecordDepth(line) {
  const validDepth = Number.isSafeInteger(line?.depth) && line.depth >= 0 && line.depth % 2 === 0;
  const depth = validDepth ? line.depth : 0;
  return { validDepth, depth };
}

function recordDepthTransition(state, index, validDepth, depth) {
  if (!validDepth) {
    state.malformedDepthTransitionCount += 1;
    return;
  }
  if (index === 0) {
    if (depth !== 0) state.malformedDepthTransitionCount += 1;
    return;
  }
  const previousDepth = state.previousDepth;
  if (previousDepth !== null && depth > previousDepth && depth !== previousDepth + 2) {
    state.malformedDepthTransitionCount += 1;
  }
}

function parseTagRecord(state, index, line) {
  const value = String(line?.value ?? '');
  const role = value.match(/^([A-Za-z][A-Za-z0-9]*)(?:\s|\(|$)/u)?.[1] ?? null;
  const roleKnown = STANDARD_TAG_ROLES.has(role);
  if (!roleKnown) state.unknownRoleCount += 1;
  const { validDepth, depth } = normalizeRecordDepth(line);
  recordDepthTransition(state, index, validDepth, depth);
  const parent = parentAtRecordDepth(state, depth);
  state.previousDepth = depth;
  return { depth, role, roleKnown, parent };
}

function recordHeading(state, role) {
  const heading = /^H([1-6])$/u.exec(role);
  if (!heading) return;
  const level = Number(heading[1]);
  const invalidSequence = state.headingCount === 0 ? level !== 1 : level > state.previousHeadingLevel + 1;
  if (invalidSequence) state.headingSequenceViolation = true;
  state.previousHeadingLevel = level;
  state.headingCount += 1;
}

function tallyExpectedParent(state, expectedParentRoles, parent, relationship) {
  if (!expectedParentRoles) return;
  const countKeys = RELATIONSHIP_COUNT_KEYS.get(relationship);
  if (!parent?.roleKnown) {
    state[countKeys.unknown] += 1;
    return;
  }
  if (!expectedParentRoles.includes(parent.role)) state[countKeys.invalid] += 1;
}

function recordExpectedParent(state, record) {
  tallyExpectedParent(state, LIST_PARENT_ROLES.get(record.role), record.parent, 'list');
  tallyExpectedParent(state, TABLE_PARENT_ROLES.get(record.role), record.parent, 'table');
}

function recordKnownRole(state, record) {
  state.counts.set(record.role, (state.counts.get(record.role) ?? 0) + 1);
  recordHeading(state, record.role);
  recordExpectedParent(state, record);
  state.stack.push({ depth: record.depth, role: record.role, roleKnown: true });
}

function recordTagLine(state, index, line) {
  const record = parseTagRecord(state, index, line);
  if (record.roleKnown) {
    recordKnownRole(state, record);
    return;
  }
  state.stack.push({ depth: record.depth, role: null, roleKnown: false });
}

function finishRoleSummary(state, recordCount) {
  const hierarchyCoverage = !state.unknownRoleCount && !state.malformedDepthTransitionCount ? 'complete' : 'unknown';
  const roleCounts = Object.freeze(Object.fromEntries([...state.counts].sort(([left], [right]) => left.localeCompare(right))));
  return Object.freeze({
    recordCount, roleCounts, unknownRoleCount: state.unknownRoleCount, hierarchyCoverage,
    malformedDepthTransitionCount: state.malformedDepthTransitionCount, headingCount: state.headingCount,
    headingSequenceViolation: state.headingSequenceViolation,
    invalidListRelationshipCount: state.invalidListRelationshipCount,
    unknownListRelationshipCount: state.unknownListRelationshipCount,
    invalidTableRelationshipCount: state.invalidTableRelationshipCount,
    unknownTableRelationshipCount: state.unknownTableRelationshipCount,
  });
}

export function summarizeTagRoles(structure) {
  const lines = structure?.taggedStructure?.lines;
  if (!Array.isArray(lines)) {
    return Object.freeze({ recordCount: 0, roleCounts: Object.freeze({}), unknownRoleCount: 0, hierarchyCoverage: 'unknown', malformedDepthTransitionCount: 0, headingCount: 0, headingSequenceViolation: false, invalidListRelationshipCount: 0, unknownListRelationshipCount: 0, invalidTableRelationshipCount: 0, unknownTableRelationshipCount: 0 });
  }
  if (lines.length > MAX_TAG_RECORDS) fail('ACCESSIBILITY_TAG_LIMIT', `Tag-role review is limited to ${MAX_TAG_RECORDS} structure records.`, 413);
  const state = createRoleState();
  for (const [index, line] of lines.entries()) recordTagLine(state, index, line);
  return finishRoleSummary(state, lines.length);
}
