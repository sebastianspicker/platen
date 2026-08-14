import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const ROLE = /^[A-Za-z][A-Za-z0-9]{0,31}$/u;
const PROFILE = 'local-tagged-pdf-remediation-v1';
const MAX_PAGES = 100;
const MAX_NODES = 1_024;
const MAX_DEPTH = 32;
const MAX_CONTENTS = 2_000;
const STANDARD_ROLES = new Set([
  'Document', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'L', 'LI', 'Lbl',
  'LBody', 'Table', 'TR', 'TH', 'TD', 'Span', 'Link', 'Artifact',
]);
const CONTAINER_CHILDREN = {
  Document: [...STANDARD_ROLES].filter((role) => !['Document', 'LI', 'Lbl', 'LBody', 'TR', 'TH', 'TD'].includes(role)),
  L: ['LI'], LI: ['Lbl', 'LBody'], Table: ['TR'], TR: ['TH', 'TD'],
};
const LEAF_CONTAINERS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'Span', 'Link', 'Lbl', 'LBody', 'TH', 'TD', 'Artifact']);
const LIMITATIONS = Object.freeze([
  'This bounded local writer either edits a complete source-bound tag tree or adds a legacy candidate tree to a narrow passive PDF subset.',
  'It does not claim PDF/UA conformance, semantic reading-order correctness, or whole-document accessibility remediation.',
  'Existing-structure mode rejects prior revisions and unsupported links, tables, forms, annotations, active content, signatures, encryption, layers, and ambiguous content.',
]);

function fail() { throw new TypeError('Tagged remediation options are invalid.'); }

function ownDataObject(value, keys, { exact = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let ownKeys; let descriptors; let prototype;
  try { prototype = Object.getPrototypeOf(value); ownKeys = Reflect.ownKeys(value); descriptors = Object.getOwnPropertyDescriptors(value); } catch { return false; }
  if (prototype !== Object.prototype) return false;
  if (ownKeys.some((key) => typeof key !== 'string' || !descriptors[key]?.enumerable
    || !Object.hasOwn(descriptors[key], 'value'))) return false;
  const names = ownKeys;
  return (exact ? names.length === keys.length && names.every((key) => keys.includes(key)) : true);
}

function ownArray(value) {
  if (!Array.isArray(value)) return false;
  let keys; let descriptors;
  try { keys = Reflect.ownKeys(value); descriptors = Object.getOwnPropertyDescriptors(value); } catch { return false; }
  if (keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^\d+$/u.test(key)))) return false;
  if (!descriptors.length || descriptors.length.enumerable || !Object.hasOwn(descriptors.length, 'value')) return false;
  for (let index = 0; index < descriptors.length.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { fail(); }
  for (const descriptor of Object.values(descriptors)) {
    if (Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function safeGraph(value, seen = new Set()) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') fail();
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    if (!ownArray(value)) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (let index = 0; index < descriptors.length.value; index += 1) {
      try { if (value[index] !== descriptors[String(index)].value) fail(); } catch { fail(); }
      safeGraph(descriptors[String(index)].value, seen);
    }
    return;
  }
  let keys; let descriptors;
  try { keys = Reflect.ownKeys(value); descriptors = Object.getOwnPropertyDescriptors(value); } catch { fail(); }
  if (!ownDataObject(value, keys.filter((key) => typeof key === 'string'))) fail();
  for (const key of keys) {
    try { if (value[key] !== descriptors[key].value) fail(); } catch { fail(); }
    safeGraph(descriptors[key].value, seen);
  }
}

function boundedString(value, maximum, ascii = false) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || value.normalize('NFC') !== value || /[\u0000-\u001f\u007f-\u009f]|\p{Cf}/u.test(value)) fail();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) fail();
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail();
  }
  if (ascii && !/^[\x20-\x7e]+$/u.test(value)) fail();
  return value;
}

function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
  return value;
}

function reference(value) {
  if (!ownDataObject(value, ['object', 'generation']) || Object.keys(value).length !== 2) fail();
  return { object: integer(value.object, 1, 1_000_000), generation: integer(value.generation, 0, 65_535) };
}

function normalizeRoleMap(value) {
  if (value === undefined) return {};
  if (!ownDataObject(value, [], { exact: false })) fail();
  const result = {};
  for (const role of Object.keys(value)) {
    const target = value[role];
    if (!ROLE.test(role) || STANDARD_ROLES.has(role) || typeof target !== 'string' || !STANDARD_ROLES.has(target)) fail();
    result[role] = target;
  }
  return result;
}

function normalizeNode(value, context, depth = 0) {
  if (!ownDataObject(value, ['id', 'role', 'page', 'contentIndex', 'children', 'structRef', 'contentRef', 'mcid', 'mode'], { exact: false })
    || Object.keys(value).length < 2 || depth > MAX_DEPTH) fail();
  const keys = Object.keys(value);
  const hasChildren = Object.hasOwn(value, 'children');
  const hasContent = Object.hasOwn(value, 'contentIndex');
  if (depth > 0 && Object.hasOwn(value, 'mode')) fail();
  if (keys.some((key) => !['id', 'role', 'page', 'contentIndex', 'children', 'structRef', 'contentRef', 'mcid', 'mode'].includes(key))) fail();
  const id = boundedString(value.id, 96, true);
  if (context.ids.has(id)) fail();
  context.ids.add(id); context.nodes += 1;
  if (context.nodes > MAX_NODES) fail();
  const role = boundedString(value.role, 32, true);
  if (!STANDARD_ROLES.has(role) && !Object.hasOwn(context.roleMap, role)) fail();
  const page = value.page === undefined ? undefined : integer(value.page, 1, MAX_PAGES);
  const contentIndex = value.contentIndex === undefined ? undefined : integer(value.contentIndex, 0, MAX_CONTENTS - 1);
  const structRef = value.structRef === undefined ? undefined : reference(value.structRef);
  const contentRef = value.contentRef === undefined ? undefined : reference(value.contentRef);
  const mcid = value.mcid === undefined ? undefined : integer(value.mcid, 0, 10_000);
  if (hasChildren && hasContent) fail();
  let children;
  if (hasChildren) {
    if (!ownArray(value.children) || value.children.length < 1) fail();
    children = value.children.map((child) => normalizeNode(child, context, depth + 1));
  } else if (contentIndex === undefined || page === undefined) fail();
  if (!hasChildren && role === 'Document') fail();
  if (hasChildren && LEAF_CONTAINERS.has(role)) fail();
  const result = { id, role };
  if (page !== undefined) result.page = page;
  if (contentIndex !== undefined) result.contentIndex = contentIndex;
  if (structRef !== undefined) result.structRef = structRef;
  if (contentRef !== undefined) result.contentRef = contentRef;
  if (mcid !== undefined) result.mcid = mcid;
  if (depth === 0 && value.mode !== undefined) result.mode = boundedString(value.mode, 64, true);
  if (children) result.children = children;
  return result;
}

function validateShape(root) {
  if (root.role !== 'Document' || root.page !== undefined || root.contentIndex !== undefined || !root.children) fail();
  const visit = (node, parentRole) => {
    const allowed = CONTAINER_CHILDREN[parentRole];
    if (allowed && !allowed.includes(node.role)) fail();
    if (parentRole === 'LI' && node.role === 'LI') fail();
    if (node.children) {
      node.children.forEach((child) => visit(child, node.role));
      if (node.role === 'LI' && !node.children.some((child) => child.role === 'LBody')) fail();
    }
  };
  root.children.forEach((child) => visit(child, 'Document'));
}

function normalizeRequest(value) {
  safeGraph(value);
  if (!ownDataObject(value, ['profile', 'sourceSha256', 'plan', 'language', 'title', 'roleMap'])
    || value.profile !== PROFILE || typeof value.sourceSha256 !== 'string' || !SHA256.test(value.sourceSha256)) fail();
  const roleMap = normalizeRoleMap(value.roleMap);
  const context = { ids: new Set(), nodes: 0, roleMap };
  const plan = normalizeNode(value.plan, context);
  validateShape(plan);
  if (plan.mode !== undefined && plan.mode !== 'existing-structure-v1') fail();
  const existing = plan.mode === 'existing-structure-v1';
  if (existing && (value.language !== null || value.title !== null)) fail();
  if (existing) {
    const refs = new Set(); const mcids = new Set();
    const visit = (node) => {
      if (!node.structRef) fail();
      const refKey = `${node.structRef.object}:${node.structRef.generation}`;
      if (refs.has(refKey)) fail();
      refs.add(refKey);
      if (!node.children) {
        if (!node.contentRef || node.mcid === undefined || node.page === undefined) fail();
        const mcidKey = `${node.page}:${node.mcid}`;
        if (mcids.has(mcidKey)) fail();
        mcids.add(mcidKey);
      }
      node.children?.forEach(visit);
    };
    visit(plan);
  }
  const language = value.language === null ? null : boundedString(value.language, 64, true);
  const title = value.title === null ? null : boundedString(value.title, 512);
  return deepFreeze({ profile: PROFILE, sourceSha256: value.sourceSha256, plan, language, title, roleMap });
}

function rejectPrivate(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:filePath|sourcePath|private|buffer)$/iu.test(key) || /%PDF|\/private\//u.test(String(child))) fail();
    rejectPrivate(child, seen);
  }
}

function validateArtifact(value, documentId, sourceSha256) {
  if (!ownDataObject(value, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'])) fail();
  if (!OPAQUE_ID_PATTERN.test(value.id) || value.documentId !== documentId || value.mediaType !== 'application/pdf'
    || typeof value.displayName !== 'string' || value.displayName.includes('/') || value.displayName.includes('\\') || value.displayName.startsWith('.')
    || !Number.isSafeInteger(value.size) || value.size < 1
    || !SHA256.test(value.sha256) || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))
    || !value.operation || typeof value.operation !== 'object') fail();
  if (!Object.hasOwn(value.operation, 'inputs') || !Array.isArray(value.operation.inputs)
    || !value.operation.inputs.some((input) => input?.documentId === documentId && input?.sha256 === sourceSha256)) fail();
  return value;
}

function validateProof(value, sourceSha256, artifactSha256, existing) {
  const base = ['profile', 'sourceSha256', 'outputSha256', 'sourcePrefixPreserved', 'originalContentStreamsUnchanged', 'deterministic', 'pageCount', 'pageGeometry', 'structureLinked', 'structTreeRootObjectNumber', 'appendedBytes', 'revisionCount', 'originalContentStreams'];
  const extra = ['tagTreeReinspected', 'textEvidence', 'renderingEvidence'];
  if (!ownDataObject(value, [...base, ...extra], { exact: false }) || !base.every((key) => Object.hasOwn(value, key))) fail();
  const keys = Object.keys(value); if (existing ? extra.some((key) => !keys.includes(key)) : extra.some((key) => keys.includes(key))) fail();
  if (value.profile !== PROFILE || value.sourceSha256 !== sourceSha256 || value.outputSha256 !== artifactSha256
    || value.sourcePrefixPreserved !== true || value.originalContentStreamsUnchanged !== true || value.deterministic !== true
    || value.structureLinked !== true || !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > MAX_PAGES
    || !Number.isSafeInteger(value.structTreeRootObjectNumber) || value.structTreeRootObjectNumber < 1
    || !Number.isSafeInteger(value.appendedBytes) || value.appendedBytes < 1 || !Number.isSafeInteger(value.revisionCount) || value.revisionCount < 2) fail();
  if (!ownArray(value.pageGeometry) || value.pageGeometry.length !== value.pageCount || !ownArray(value.originalContentStreams)) fail();
  value.pageGeometry.forEach((geometry) => {
    if (!ownDataObject(geometry, ['mediaBox', 'cropBox', 'rotate']) || !ownArray(geometry.mediaBox) || !ownArray(geometry.cropBox)
      || geometry.mediaBox.length !== 4 || geometry.cropBox.length !== 4 || !geometry.mediaBox.every(Number.isFinite)
      || !geometry.cropBox.every(Number.isFinite) || !Number.isSafeInteger(geometry.rotate)) fail();
  });
  value.originalContentStreams.forEach((stream) => {
    if (!ownDataObject(stream, ['page', 'contentIndex', 'sha256', 'bytes']) || !Number.isSafeInteger(stream.page)
      || stream.page < 1 || stream.page > MAX_PAGES || !Number.isSafeInteger(stream.contentIndex) || stream.contentIndex < 0
      || stream.contentIndex >= MAX_CONTENTS || !SHA256.test(stream.sha256) || !Number.isSafeInteger(stream.bytes) || stream.bytes < 0) fail();
  });
  if (existing && (value.tagTreeReinspected !== true || value.textEvidence !== 'content-streams-unchanged'
    || value.renderingEvidence !== 'page-geometry-and-content-preserved')) fail();
  return value;
}

function validateResult(body, documentId, request) {
  safeGraph(body);
  if (!ownDataObject(body, ['result']) || !ownDataObject(body.result, ['kind', 'profile', 'sourceDigest', 'artifact', 'proof', 'evidence', 'limitations'])
    || body.result.kind !== 'tagged-pdf-remediation' || body.result.profile !== PROFILE || body.result.sourceDigest !== request.sourceSha256) fail();
  const result = body.result;
  validateArtifact(result.artifact, documentId, request.sourceSha256);
  validateProof(result.proof, request.sourceSha256, result.artifact.sha256, request.plan.mode === 'existing-structure-v1');
  if (!ownDataObject(result.evidence, ['sourceBound', 'sourceUnchanged', 'outputDigestBound', 'independentInspection'])
    || Object.values(result.evidence).some((value) => value !== true) || !ownArray(result.limitations)
    || result.limitations.length !== LIMITATIONS.length || result.limitations.some((value, index) => value !== LIMITATIONS[index])) fail();
  rejectPrivate(result);
  return deepFreeze(result);
}

export function createTaggedRemediationEndpoints({ json }) {
  return Object.freeze({
    updateTaggedRemediation(documentId, request, options = {}) {
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !ownDataObject(options, ['signal'], { exact: false })
        || Object.keys(options).some((key) => key !== 'signal') || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) fail();
      const normalized = normalizeRequest(request);
      const signal = options.signal;
      return json(`/api/documents/${encodeURIComponent(documentId)}/tagged-remediation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalized), signal,
      }).then((body) => validateResult(body, documentId, normalized));
    },
  });
}
