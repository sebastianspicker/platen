import { check } from './accessibility-review-check-contract.mjs';

export function languageFromStructure(structure) {
  const languagePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
  const custom = (structure?.customMetadata ?? []).find(({ name, value }) => (
    /^(?:language|lang|dc:language)$/i.test(String(name ?? ''))
    && languagePattern.test(String(value ?? '').trim())
  ));
  if (custom) return String(custom.value).trim();

  const xml = String(structure?.xmpMetadata?.xml ?? '');
  const match = (
    xml.match(
      /<dc:language(?:\s[^>]*)?>[\s\S]{0,4096}?<rdf:li(?:\s[^>]*)?>\s*([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\s*<\/rdf:li>/i,
    )
    ?? xml.match(
      /<(?:dc:language|pdf:Lang|xmp:Language)(?:\s[^>]*)?>\s*([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\s*<\/(?:dc:language|pdf:Lang|xmp:Language)>/i,
    )
    ?? xml.match(/(?:xml:lang|language)=["']([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)["']/i)
  );
  return match?.[1] ?? null;
}

function tagInventoryCheck(taggedIndicator, tagStructure, roles) {
  const counts = roles.roleCounts;
  if (!taggedIndicator || !tagStructure) {
    return check(
      'tag-role-inventory',
      'not-checked',
      'A semantic role inventory requires a reported tag structure.',
    );
  }
  if (counts.Document && roles.hierarchyCoverage === 'complete') {
    return check(
      'tag-role-inventory',
      'pass',
      'The bounded tag-role inventory contains a Document structure element.',
    );
  }
  return check(
    'tag-role-inventory',
    'warning',
    counts.Document
      ? 'A Document role was reported, but custom roles or malformed depth transitions make the inventory incomplete.'
      : 'A tag structure was listed, but no standard Document role was reported.',
  );
}

function headingCheck(roles) {
  if (!roles.headingCount) {
    return check(
      'heading-role-sequence',
      'not-checked',
      'No numbered heading roles were reported for hierarchy review.',
    );
  }
  if (roles.headingSequenceViolation) {
    return check(
      'heading-role-sequence',
      'warning',
      'The reported heading-role sequence starts below H1 or skips a level.',
    );
  }
  if (roles.hierarchyCoverage === 'complete') {
    return check(
      'heading-role-sequence',
      'pass',
      'The reported numbered heading-role sequence has no detected level skip.',
    );
  }
  return check(
    'heading-role-sequence',
    'not-checked',
    'Custom roles or malformed depth transitions prevent a complete heading-sequence result.',
  );
}

function listCheck(roles) {
  const counts = roles.roleCounts;
  const listCount = counts.L ?? 0;
  const listItemCount = counts.LI ?? 0;
  const listBodyCount = counts.LBody ?? 0;
  if (!listCount) {
    return check('list-role-shape', 'not-checked', 'No standard list roles were reported.');
  }
  if (roles.invalidListRelationshipCount) {
    return check('list-role-shape', 'warning', 'One or more reported list roles have a known but unexpected parent role.');
  }
  if (roles.hierarchyCoverage !== 'complete' || roles.unknownListRelationshipCount) {
    return check('list-role-shape', 'not-checked', 'Custom roles or malformed depth transitions prevent complete list hierarchy coverage.');
  }
  if (listItemCount >= listCount && listBodyCount >= listItemCount) {
    return check('list-role-shape', 'pass', 'The bounded hierarchy places list items under lists and labels/bodies under list items.');
  }
  return check('list-role-shape', 'warning', 'One or more reported list roles lack a corresponding item or body role.');
}

function tableCheck(roles) {
  const counts = roles.roleCounts;
  const tableCount = counts.Table ?? 0;
  const rowCount = counts.TR ?? 0;
  const cellCount = (counts.TH ?? 0) + (counts.TD ?? 0);
  const headerCount = counts.TH ?? 0;
  if (!tableCount) return check('table-role-shape', 'not-checked', 'No standard table roles were reported.');
  if (roles.invalidTableRelationshipCount) return check('table-role-shape', 'warning', 'One or more reported table rows or cells have a known but unexpected parent role.');
  if (roles.hierarchyCoverage !== 'complete' || roles.unknownTableRelationshipCount) return check('table-role-shape', 'not-checked', 'Custom roles or malformed depth transitions prevent complete table hierarchy coverage.');
  if (rowCount < tableCount || !cellCount) return check('table-role-shape', 'warning', 'One or more reported tables lack a row or cell role.');
  if (!headerCount) return check('table-role-shape', 'warning', 'Table rows and cells were reported, but no TH header role was found.');
  return check('table-role-shape', 'pass', 'The reported table roles include rows, cells, and at least one header cell.');
}

export function tagSemanticChecks({ taggedIndicator, tagStructure, roles }) {
  return [
    tagInventoryCheck(taggedIndicator, tagStructure, roles),
    headingCheck(roles),
    listCheck(roles),
    tableCheck(roles),
  ];
}
