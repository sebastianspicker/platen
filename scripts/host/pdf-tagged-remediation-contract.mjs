const SHA256 = /^[a-f0-9]{64}$/u;
const ROLE = /^[A-Za-z][A-Za-z0-9]{0,31}$/u;

export const TAGGED_PDF_REMEDIATION_PROFILE = 'local-tagged-pdf-remediation-v1';
export const TAGGED_PDF_REMEDIATION_MAX_PAGES = 100;
export const TAGGED_PDF_REMEDIATION_MAX_NODES = 1_024;
export const TAGGED_PDF_REMEDIATION_MAX_DEPTH = 32;
export const TAGGED_PDF_REMEDIATION_MAX_CONTENTS = 2_000;
export const TAGGED_PDF_STANDARD_ROLES = Object.freeze([
  'Document', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'L', 'LI', 'Lbl',
  'LBody', 'Table', 'TR', 'TH', 'TD', 'Span', 'Link', 'Artifact',
]);

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function invalid(message = 'The tagged-PDF remediation request is invalid.') {
  return failure('INVALID_TAGGED_PDF_REMEDIATION_REQUEST', message);
}
function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.getOwnPropertySymbols(value).length === 0;
}
function exact(value, keys, label) {
  if (!plain(value) || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))) throw invalid(`${label} contains an unsupported field.`);
  return value;
}
function string(value, label, maximum, { ascii = false } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || value.normalize('NFC') !== value || /[\u0000-\u001f\u007f-\u009f]|\p{Cf}/u.test(value)) throw invalid(`${label} is invalid.`);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) throw invalid(`${label} contains an unpaired surrogate.`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw invalid(`${label} contains an unpaired surrogate.`);
  }
  if (ascii && !/^[\x20-\x7e]+$/u.test(value)) throw invalid(`${label} must be ASCII.`);
  return value;
}
function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid(`${label} is out of bounds.`);
  return value;
}

function reference(value, label) {
  if (!plain(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'object') || !Object.hasOwn(value, 'generation')) {
    throw invalid(`${label} is invalid.`);
  }
  return frozen({
    object: integer(value.object, `${label}.object`, 1, 1_000_000),
    generation: integer(value.generation, `${label}.generation`, 0, 65_535),
  });
}
function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeRoleMap(value) {
  if (value === undefined) return Object.freeze({});
  if (!plain(value)) throw invalid('roleMap must be a plain object.');
  const result = {};
  for (const [role, target] of Object.entries(value)) {
    if (!ROLE.test(role) || TAGGED_PDF_STANDARD_ROLES.includes(role)) throw invalid('roleMap contains an invalid custom role.');
    if (typeof target !== 'string' || !TAGGED_PDF_STANDARD_ROLES.includes(target)) throw invalid('roleMap targets must be standard roles.');
    result[role] = target;
  }
  return Object.freeze(result);
}

function normalizeNode(value, context, depth = 0) {
  if (depth > TAGGED_PDF_REMEDIATION_MAX_DEPTH) throw invalid('The semantic plan is too deeply nested.');
  const keys = Object.keys(value ?? {});
  if (!plain(value)) throw invalid('Every semantic node must be a plain object.');
  const hasChildren = Object.hasOwn(value, 'children');
  const hasContent = Object.hasOwn(value, 'contentIndex');
  const allowed = ['id', 'role', 'page', 'contentIndex', 'children', 'structRef', 'contentRef', 'mcid', 'mode'];
  if (keys.some((key) => !allowed.includes(key)) || keys.length < 2) throw invalid('A semantic node has invalid fields.');
  if (depth > 0 && Object.hasOwn(value, 'mode')) throw invalid('Only the plan root may declare a remediation mode.');
  const id = string(value.id, 'semantic node id', 96, { ascii: true });
  if (context.ids.has(id)) throw invalid('Semantic node ids must be unique.');
  context.ids.add(id); context.nodes += 1;
  if (context.nodes > TAGGED_PDF_REMEDIATION_MAX_NODES) throw invalid('The semantic plan contains too many nodes.');
  const role = string(value.role, 'semantic role', 32, { ascii: true });
  if (!TAGGED_PDF_STANDARD_ROLES.includes(role) && !Object.hasOwn(context.roleMap, role)) throw invalid(`Role ${role} requires an explicit roleMap entry.`);
  let page = value.page;
  if (page !== undefined) page = integer(page, 'page', 1, TAGGED_PDF_REMEDIATION_MAX_PAGES);
  let contentIndex = value.contentIndex;
  if (contentIndex !== undefined) contentIndex = integer(contentIndex, 'contentIndex', 0, TAGGED_PDF_REMEDIATION_MAX_CONTENTS - 1);
  const structRef = value.structRef === undefined ? undefined : reference(value.structRef, 'structRef');
  const contentRef = value.contentRef === undefined ? undefined : reference(value.contentRef, 'contentRef');
  let mcid = value.mcid;
  if (mcid !== undefined) mcid = integer(mcid, 'mcid', 0, 10_000);
  if (hasChildren && hasContent) throw invalid('Container nodes cannot also target a content stream.');
  let children = [];
  if (hasChildren) {
    if (!Array.isArray(value.children) || value.children.length < 1) throw invalid('Container nodes must have children.');
    children = value.children.map((child) => normalizeNode(child, context, depth + 1));
  } else if (contentIndex === undefined || page === undefined) {
    throw invalid('Leaf nodes require page and contentIndex.');
  }
  if (!hasChildren && role === 'Document') throw invalid('Document must be a container.');
  if (hasChildren && ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'Span', 'Link', 'Lbl', 'LBody', 'TH', 'TD', 'Artifact'].includes(role)) throw invalid(`${role} cannot contain children.`);
  return frozen({ id, role, ...(page === undefined ? {} : { page }), ...(contentIndex === undefined ? {} : { contentIndex }), ...(structRef === undefined ? {} : { structRef }), ...(contentRef === undefined ? {} : { contentRef }), ...(mcid === undefined ? {} : { mcid }), ...(depth === 0 && value.mode !== undefined ? { mode: string(value.mode, 'remediation mode', 64, { ascii: true }) } : {}), ...(hasChildren ? { children: Object.freeze(children) } : {}) });
}

function validateShape(root) {
  if (root.role !== 'Document' || root.page !== undefined || root.contentIndex !== undefined) throw invalid('The semantic plan root must be a page-independent Document container.');
  const visit = (node, parentRole) => {
    const role = node.role;
    const allowed = {
      Document: TAGGED_PDF_STANDARD_ROLES.filter((candidate) => !['Document', 'LI', 'Lbl', 'LBody', 'TR', 'TH', 'TD'].includes(candidate)),
      L: ['LI'], LI: ['Lbl', 'LBody'], Table: ['TR'], TR: ['TH', 'TD'],
    }[parentRole];
    if (allowed && !allowed.includes(role)) throw invalid(`${role} cannot be nested under ${parentRole}.`);
    if (parentRole === 'LI' && role === 'LI') throw invalid('Lists cannot contain nested list items in this bounded profile.');
    if (node.children) {
      for (const child of node.children) visit(child, role);
      if (role === 'LI' && !node.children.some((child) => child.role === 'LBody')) throw invalid('Every LI requires an LBody child.');
    }
  };
  for (const child of root.children) visit(child, 'Document');
}

export function normalizeTaggedPdfRemediationRequest(value) {
  try {
    const input = exact(value, ['profile', 'sourceSha256', 'plan', 'language', 'title', 'roleMap'], 'Tagged-PDF remediation request');
    if (input.profile !== TAGGED_PDF_REMEDIATION_PROFILE || typeof input.sourceSha256 !== 'string' || !SHA256.test(input.sourceSha256)) throw invalid('profile or sourceSha256 is invalid.');
    const roleMap = normalizeRoleMap(input.roleMap);
    const context = { ids: new Set(), nodes: 0, roleMap };
    const plan = normalizeNode(input.plan, context);
    validateShape(plan);
    if (plan.mode !== undefined && plan.mode !== 'existing-structure-v1') throw invalid('The remediation mode is unsupported.');
    if (plan.mode === 'existing-structure-v1') {
      if (input.language !== null || input.title !== null) throw invalid('Existing-structure remediation cannot change document metadata.');
      const references = new Set(); const mcids = new Set();
      const visit = (node) => {
        if (!node.structRef) throw invalid('Existing-structure nodes require exact StructElem references.');
        const structKey = `${node.structRef.object}:${node.structRef.generation}`;
        if (references.has(structKey)) throw invalid('StructElem references must be unique.');
        references.add(structKey);
        if (!node.children) {
          if (!node.contentRef || node.mcid === undefined || node.page === undefined) throw invalid('Existing-structure leaves require page, contentRef, and MCID.');
          const mcidKey = `${node.page}:${node.mcid}`;
          if (mcids.has(mcidKey)) throw invalid('MCIDs must be unique per page.');
          mcids.add(mcidKey);
        }
        node.children?.forEach(visit);
      };
      visit(plan);
    }
    const language = input.language === null ? null : string(input.language, 'language', 64, { ascii: true });
    const title = input.title === null ? null : string(input.title, 'title', 512);
    return frozen({ profile: TAGGED_PDF_REMEDIATION_PROFILE, sourceSha256: input.sourceSha256, plan, language, title, roleMap });
  } catch (error) {
    if (error?.code === 'INVALID_TAGGED_PDF_REMEDIATION_REQUEST') throw error;
    throw invalid();
  }
}

export const normalizeTaggedPdfRequest = normalizeTaggedPdfRemediationRequest;
